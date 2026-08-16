/// The web spool: same API, memory instead of a filesystem.
///
/// The disk spool exists for one reason — on mobile and server, an uncaught
/// error usually means the process is about to disappear, so the report has to
/// be durable *before* it dies and sent on the next launch. The browser does
/// not work that way: an uncaught error rejects a frame, the page keeps
/// running, and the ordinary in-memory buffer flushes it on the next tick like
/// any other record. So on web the durable queue buys almost nothing, and
/// there is no synchronous filesystem to build it on regardless.
///
/// What this deliberately does *not* do is reach for `localStorage`. That would
/// need `package:web` and a Dart 3.3 floor for a queue that, on this platform,
/// is nearly always drained microseconds later by the same flush timer.
///
/// The honest cost, so nobody discovers it from a missing graph:
///   • a report queued in the instant before a reload or tab close is lost;
///   • sessions cannot be correlated across a reload, so a web session never
///     reports as `abnormal` — [beginSession] has no previous run to find.
/// Everything else — requests, errors, logs, traces, breadcrumbs — behaves as
/// it does anywhere else.
library;

import 'spool_record.dart';

class CrashSpool {
  /// Takes a path for API parity with the `dart:io` spool. There is no
  /// filesystem here, so it is ignored rather than made optional — the calling
  /// code stays identical on every platform.
  CrashSpool(String directoryPath);

  /// No filesystem, so no durable install id.
  ///
  /// Returning null means the caller generates a per-run id: on web a reload
  /// therefore reads as a new anonymous person. That is the same trade already
  /// made for sessions above, and the browser SDK — which does have storage —
  /// is the right tool when web analytics matter.
  String? readInstallId() => _installId;

  void writeInstallId(String id) => _installId = id;

  String? _installId;

  final List<SpooledRecord> _pending = [];
  Map<String, dynamic>? _session;

  /// Never true here: memory does not run out of permissions or disk space.
  /// Kept so callers can branch on it without a platform check.
  bool unusable = false;

  void appendSync(String kind, Map<String, dynamic> json) {
    if (unusable) return;
    _pending.add(SpooledRecord(kind, json));
  }

  List<SpooledRecord> drain() {
    if (unusable || _pending.isEmpty) return const [];
    final out = List<SpooledRecord>.from(_pending);
    _pending.clear();
    return out;
  }

  /// Always returns null: nothing survives a reload, so there is never a
  /// previous session to report on.
  Map<String, dynamic>? beginSession(Map<String, dynamic> session) {
    if (unusable) return null;
    _session = Map<String, dynamic>.from(session);
    return null;
  }

  void markSessionCrashed() {
    if (unusable) return;
    _session?['crashed'] = true;
  }

  void endSession() {
    if (unusable) return;
    _session = null;
  }

  /// Test seam.
  void clear() {
    _pending.clear();
    _session = null;
  }
}
