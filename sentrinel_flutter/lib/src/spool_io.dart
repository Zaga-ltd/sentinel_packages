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
///
/// A record leaves the disk only when the server has it. [drain] moves the
/// queue to `inflight.ndjson` rather than deleting it, and [acknowledge] removes
/// lines once their batch got a 2xx. The old reader deleted the file the moment
/// it was read, so a crash report whose replay hit a dead network — the usual
/// state of a phone that just crashed on a train — was gone for good.
library;

import 'dart:convert';
import 'dart:io';

import 'json_safe.dart';
import 'spool_record.dart';
import 'trace.dart';

/// How many records one run may write. A dying process does not produce fifty
/// distinct fatal errors; a loop that does should not fill the disk with them.
const int kMaxSpooledRecords = 50;

/// And how large the queue may grow, whatever the count.
const int kMaxSpoolBytes = 256 * 1024;

class CrashSpool {
  CrashSpool(
    String directoryPath, {
    this.maxRecords = kMaxSpooledRecords,
    this.maxBytes = kMaxSpoolBytes,
  }) : _dir = Directory(directoryPath);

  final Directory _dir;
  final int maxRecords;
  final int maxBytes;

  File get _pending => File('${_dir.path}/pending.ndjson');

  /// Records a launch has read and is trying to deliver. Survives until the
  /// server acknowledges them, so a failed replay is retried next time.
  File get _inflight => File('${_dir.path}/inflight.ndjson');

  /// Present while a session is running; absent after a clean shutdown. Finding
  /// one at startup means the previous run did not get to close itself.
  File get _sessionMarker => File('${_dir.path}/session.json');

  File get _installFile => File('${_dir.path}/install.id');

  /// Set when the directory turns out to be unusable — read-only, missing, out
  /// of space. Recorded so the SDK degrades to in-memory rather than throwing
  /// into the host app on every single record.
  ///
  /// Only a filesystem failure sets it. A record that cannot be *encoded* is a
  /// problem with that record, and used to disable the spool for the rest of
  /// the run — every later crash then went unreported.
  bool unusable = false;

  /// Whether a record appended here survives the process. The caller sends
  /// straight to the network when it does not.
  bool get durable => !unusable;

  int _appended = 0;
  int? _pendingBytes;
  final Set<String> _fingerprints = {};

  /// The live session marker, cached so marking it crashed does not read and
  /// parse the file on every fatal error.
  Map<String, dynamic>? _session;
  bool _crashedMarked = false;

  void _ensureDir() {
    if (!_dir.existsSync()) _dir.createSync(recursive: true);
  }

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

  /// Queue a record for delivery, synchronously. Returns the id to
  /// [acknowledge] it with, or null when it was not written — a duplicate
  /// [fingerprint] this run, the queue at its cap, or storage unusable. Null
  /// means "not durable": the caller still has the record in memory.
  ///
  /// [fsync] forces the bytes to the device before returning. Right for a
  /// fatal error, where the process may be gone on the next line; wasted on
  /// anything else, and it blocks the UI thread while it waits.
  String? append(
    String kind,
    Map<String, dynamic> json, {
    String? fingerprint,
    bool fsync = true,
  }) {
    if (unusable) return null;
    if (_appended >= maxRecords) return null;
    if (fingerprint != null && _fingerprints.contains(fingerprint)) return null;

    final id = generateSpanId();
    final String line;
    try {
      line = '${safeJsonEncode({'id': id, 'kind': kind, 'record': json})}\n';
    } catch (_) {
      // A cycle in the app's attributes. This record cannot be stored; the
      // next one very likely can, so the spool stays open.
      return null;
    }

    try {
      _ensureDir();
      _pendingBytes ??= _pending.existsSync() ? _pending.lengthSync() : 0;
      if (_pendingBytes! + line.length > maxBytes) return null;
      _pending.writeAsStringSync(line, mode: FileMode.append, flush: fsync);
    } catch (_) {
      // A monitoring SDK must not be the reason a crash gets worse.
      unusable = true;
      return null;
    }
    _pendingBytes = _pendingBytes! + line.length;
    _appended++;
    if (fingerprint != null) _fingerprints.add(fingerprint);
    return id;
  }

  /// The pre-0.3 name. Always forces the write to disk, as it always did.
  void appendSync(String kind, Map<String, dynamic> json) => append(kind, json);

  /// Everything earlier runs left behind, including a previous replay the
  /// server never confirmed.
  ///
  /// Nothing is deleted here. The records move to `inflight.ndjson` and stay
  /// there until [acknowledge] is called with their ids; a launch that dies or
  /// goes offline before that simply finds them again next time.
  List<SpooledRecord> drain() {
    if (unusable) return const [];
    try {
      final lines = <String>[
        if (_inflight.existsSync()) ..._inflight.readAsLinesSync(),
        if (_pending.existsSync()) ..._pending.readAsLinesSync(),
      ];
      if (lines.isEmpty) return const [];

      final seen = <String>{};
      final out = <SpooledRecord>[];
      for (final line in lines) {
        if (line.trim().isEmpty) continue;
        try {
          final parsed = jsonDecode(line) as Map<String, dynamic>;
          final kind = parsed['kind'];
          final record = parsed['record'];
          // Lines from before ids existed get one now; the rewrite below
          // stores it, so acknowledging them works like any other.
          final id = (parsed['id'] as String?) ?? generateSpanId();
          if (kind is String && record is Map<String, dynamic> && seen.add(id)) {
            out.add(SpooledRecord(kind, record, id: id));
          }
        } catch (_) {
          // A half-written trailing line from a process that died mid-append.
          // Expected; the rest of the file is still good.
        }
      }

      // Bounded, newest kept: an app that crashed on every launch while
      // offline for a week should not replay a thousand reports at once.
      final keep = out.length > maxRecords * 2
          ? out.sublist(out.length - maxRecords * 2)
          : out;

      // Inflight first, then remove pending. Dying between the two leaves a
      // record in both, and the id dedupe above folds them back into one.
      _writeLines(_inflight, keep);
      if (_pending.existsSync()) _pending.deleteSync();
      _pendingBytes = 0;
      return keep;
    } catch (_) {
      unusable = true;
      return const [];
    }
  }

  /// The server has these. Remove them from wherever they are queued.
  ///
  /// Called after a 2xx, and after a 4xx that says the record will never be
  /// accepted — retrying that forever would replay it on every launch.
  void acknowledge(Iterable<String> ids) {
    if (unusable) return;
    final done = ids.toSet();
    if (done.isEmpty) return;
    for (final file in [_inflight, _pending]) {
      try {
        if (!file.existsSync()) continue;
        final lines = file.readAsLinesSync();
        final remaining = <String>[];
        var removed = 0;
        for (final line in lines) {
          if (line.trim().isEmpty) continue;
          String? id;
          try {
            id = (jsonDecode(line) as Map<String, dynamic>)['id'] as String?;
          } catch (_) {
            // Unparseable: drain() would skip it too, so it goes.
            removed++;
            continue;
          }
          if (id != null && done.contains(id)) {
            removed++;
          } else {
            remaining.add(line);
          }
        }
        if (removed == 0) continue;
        if (remaining.isEmpty) {
          file.deleteSync();
        } else {
          file.writeAsStringSync('${remaining.join('\n')}\n', flush: true);
        }
        if (file.path == _pending.path) {
          _pendingBytes = remaining.isEmpty ? 0 : file.lengthSync();
        }
      } catch (_) {
        // Worst case the record is sent once more on the next launch; the
        // server dedupes nothing, but one duplicate beats one lost crash.
      }
    }
  }

  void _writeLines(File file, List<SpooledRecord> records) {
    if (records.isEmpty) {
      if (file.existsSync()) file.deleteSync();
      return;
    }
    final text = records
        .map((r) => safeJsonEncode({'id': r.id, 'kind': r.kind, 'record': r.json}))
        .join('\n');
    file.writeAsStringSync('$text\n', flush: true);
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
      _session = Map<String, dynamic>.from(session);
      _crashedMarked = session['crashed'] == true;
      _sessionMarker.writeAsStringSync(safeJsonEncode(_session), flush: true);
    } catch (_) {
      unusable = true;
    }
    return previous;
  }

  /// Put the marker back for a session that was paused, without treating the
  /// file already there as a previous run. See `Sentrinel.onForeground`.
  void resumeSession(Map<String, dynamic> session) {
    if (unusable) return;
    try {
      _ensureDir();
      _session = Map<String, dynamic>.from(session);
      _crashedMarked = session['crashed'] == true;
      _sessionMarker.writeAsStringSync(safeJsonEncode(_session), flush: true);
    } catch (_) {
      unusable = true;
    }
  }

  /// Note on the live session marker that a fatal error was written.
  ///
  /// This is what lets the next launch tell `crashed` from `abnormal`. Both
  /// leave the marker behind; only a crash leaves a report next to it. Counting
  /// a force-quit against a release would make crash-free rate worthless, so
  /// the distinction is recorded at the moment it is known — once. The flag is
  /// cached, so a second fatal error costs nothing.
  void markSessionCrashed() {
    if (unusable || _crashedMarked) return;
    _crashedMarked = true;
    final session = _session;
    if (session == null) return;
    try {
      session['crashed'] = true;
      _sessionMarker.writeAsStringSync(safeJsonEncode(session), flush: true);
    } catch (_) {
      // The crash report itself is already safely on disk; losing the finer
      // label is survivable, and throwing here would not be.
    }
  }

  /// Record a clean shutdown, so the next launch does not report a crash.
  void endSession() {
    _session = null;
    _crashedMarked = false;
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
      if (_inflight.existsSync()) _inflight.deleteSync();
      if (_sessionMarker.existsSync()) _sessionMarker.deleteSync();
    } catch (_) {}
    _pendingBytes = null;
    _appended = 0;
    _fingerprints.clear();
  }
}
