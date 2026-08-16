/// On-disk queue for reports that must outlive the process.
///
/// This is the difference between "we noticed an error" and crash reporting.
/// Everything else in this SDK buffers in memory and flushes on a timer — which
/// is right for ordinary telemetry and useless for a crash, because the process
/// is gone long before the next tick. A crash report has to be on disk *before*
/// the app dies, and sent on the next launch.
///
/// So the write is synchronous and append-only. `File.writeAsStringSync` with
/// `FileMode.append` is a single `write(2)`; if the process is killed
/// mid-sentence the worst case is one truncated trailing line, which the reader
/// discards. That is a far better failure mode than losing the report.
///
/// NDJSON rather than one JSON document for the same reason: appending a line
/// never requires reading, parsing and rewriting what is already there.
library;

import 'dart:convert';
import 'dart:io';

import 'spool_record.dart';

class CrashSpool {
  CrashSpool(String directoryPath) : _dir = Directory(directoryPath);

  final Directory _dir;

  File get _pending => File('${_dir.path}/pending.ndjson');

  /// Present while a session is running; absent after a clean shutdown. Finding
  /// one at startup means the previous run did not get to close itself.
  File get _sessionMarker => File('${_dir.path}/session.json');

  /// Set when the directory turns out to be unusable — read-only, missing, out
  /// of space. Recorded so the SDK degrades to in-memory rather than throwing
  /// into the host app on every single record.
  bool unusable = false;

  void _ensureDir() {
    if (!_dir.existsSync()) _dir.createSync(recursive: true);
  }

  File get _installFile => File('${_dir.path}/install.id');

  /// The stable per-install id used to attribute product events.
  ///
  /// It has to outlive the process or every launch reads as a brand-new
  /// person: retention would be flat, funnels would never complete across a
  /// restart, and "daily actives" would just be launches. Written once and
  /// read thereafter.
  ///
  /// Returns null when the directory is unusable, and the caller falls back to
  /// a per-run id — worse analytics, but never a crash in a monitoring SDK.
  String? readInstallId() {
    if (unusable) return null;
    try {
      _ensureDir();
      if (!_installFile.existsSync()) return null;
      final value = _installFile.readAsStringSync().trim();
      return value.isEmpty ? null : value;
    } catch (_) {
      return null;
    }
  }

  void writeInstallId(String id) {
    if (unusable) return;
    try {
      _ensureDir();
      _installFile.writeAsStringSync(id, flush: true);
    } catch (_) {
      // Same policy as everything else here: degrade, never throw.
    }
  }

  /// Queue a record for delivery, synchronously.
  ///
  /// Called from crash handlers, where every asynchronous gap is a chance for
  /// the process to disappear first.
  void appendSync(String kind, Map<String, dynamic> json) {
    if (unusable) return;
    try {
      _ensureDir();
      _pending.writeAsStringSync(
        '${jsonEncode({'kind': kind, 'record': json})}\n',
        mode: FileMode.append,
        flush: true,
      );
    } catch (_) {
      // A monitoring SDK must not be the reason a crash gets worse.
      unusable = true;
    }
  }

  /// Everything queued by earlier runs. Clears the queue as it goes, so a
  /// report cannot be sent twice even if this launch also crashes.
  List<SpooledRecord> drain() {
    if (unusable) return const [];
    try {
      if (!_pending.existsSync()) return const [];
      final text = _pending.readAsStringSync();
      _pending.deleteSync();

      final out = <SpooledRecord>[];
      for (final line in text.split('\n')) {
        if (line.trim().isEmpty) continue;
        try {
          final parsed = jsonDecode(line) as Map<String, dynamic>;
          final kind = parsed['kind'];
          final record = parsed['record'];
          if (kind is String && record is Map<String, dynamic>) {
            out.add(SpooledRecord(kind, record));
          }
        } catch (_) {
          // A half-written trailing line from a process that died mid-append.
          // Expected; the rest of the file is still good.
        }
      }
      return out;
    } catch (_) {
      unusable = true;
      return const [];
    }
  }

  /// Mark a session as running. Returns what the previous session left behind,
  /// or null if it shut down cleanly.
  Map<String, dynamic>? beginSession(Map<String, dynamic> session) {
    if (unusable) return null;
    Map<String, dynamic>? previous;
    try {
      _ensureDir();
      if (_sessionMarker.existsSync()) {
        try {
          previous = jsonDecode(_sessionMarker.readAsStringSync()) as Map<String, dynamic>;
        } catch (_) {
          // Unreadable marker still tells us the last run did not close.
          previous = <String, dynamic>{};
        }
      }
      _sessionMarker.writeAsStringSync(jsonEncode(session), flush: true);
    } catch (_) {
      unusable = true;
    }
    return previous;
  }

  /// Note on the live session marker that a fatal error was written.
  ///
  /// This is what lets the next launch tell `crashed` from `abnormal`. Both
  /// leave the marker behind; only a crash leaves a report next to it. Counting
  /// a force-quit against a release would make crash-free rate worthless, so
  /// the distinction is recorded at the moment it is known.
  void markSessionCrashed() {
    if (unusable) return;
    try {
      if (!_sessionMarker.existsSync()) return;
      final marker = jsonDecode(_sessionMarker.readAsStringSync()) as Map<String, dynamic>;
      if (marker['crashed'] == true) return; // already noted; skip the write
      marker['crashed'] = true;
      _sessionMarker.writeAsStringSync(jsonEncode(marker), flush: true);
    } catch (_) {
      // The crash report itself is already safely on disk; losing the finer
      // label is survivable, and throwing here would not be.
    }
  }

  /// Record a clean shutdown, so the next launch does not report a crash.
  void endSession() {
    if (unusable) return;
    try {
      if (_sessionMarker.existsSync()) _sessionMarker.deleteSync();
    } catch (_) {
      unusable = true;
    }
  }

  /// Test seam.
  void clear() {
    try {
      if (_pending.existsSync()) _pending.deleteSync();
      if (_sessionMarker.existsSync()) _sessionMarker.deleteSync();
    } catch (_) {}
  }
}
