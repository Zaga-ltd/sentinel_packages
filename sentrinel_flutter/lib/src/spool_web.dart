/// The web spool: same API, nothing durable.
///
/// The disk spool exists for one reason — on mobile and server, an uncaught
/// error can mean the process is about to disappear, so the report has to be
/// durable *before* it dies and sent on the next launch. The browser does not
/// work that way, and there is no synchronous filesystem to build it on.
///
/// This used to keep "spooled" records in a list that was only read at init —
/// which on web happens once per page load, before any error. Every fatal
/// error on Flutter web went into that list and never left it. Now [append]
/// refuses, [durable] is false, and the caller sends the record straight
/// through the in-memory collector and flushes, like any other record.
///
/// What this deliberately does *not* do is reach for `localStorage`. That would
/// need `package:web` and a Dart 3.3 floor for a queue that, on this platform,
/// the network path already covers.
///
/// The honest cost, so nobody discovers it from a missing graph:
///   • a report queued in the instant before a reload or tab close is lost;
///   • sessions cannot be correlated across a reload, so a web session never
///     reports as `abnormal` — [beginSession] has no previous run to find;
///   • the install id lives for one page load, so a reload is a new guest.
library;

import 'spool_record.dart';

class CrashSpool {
  /// Takes a path for API parity with the `dart:io` spool. There is no
  /// filesystem here, so it is ignored rather than made optional — the calling
  /// code stays identical on every platform.
  CrashSpool(String directoryPath, {int maxRecords = 0, int maxBytes = 0});

  /// No filesystem, so no durable install id.
  String? readInstallId() => _installId;

  void writeInstallId(String id) => _installId = id;

  String? _installId;

  /// Never true here: memory does not run out of permissions or disk space.
  /// Kept so callers can branch on it without a platform check.
  bool unusable = false;

  /// Nothing written here survives anything, so the caller must not rely on it.
  bool get durable => false;

  /// Always null — "not stored". The caller then keeps the record in memory
  /// and sends it on the next flush.
  String? append(
    String kind,
    Map<String, dynamic> json, {
    String? fingerprint,
    bool fsync = true,
  }) =>
      null;

  void appendSync(String kind, Map<String, dynamic> json) {}

  List<SpooledRecord> drain() => const [];

  void acknowledge(Iterable<String> ids) {}

  /// Always returns null: nothing survives a reload, so there is never a
  /// previous session to report on.
  Map<String, dynamic>? beginSession(Map<String, dynamic> session) => null;

  void resumeSession(Map<String, dynamic> session) {}

  void markSessionCrashed() {}

  void endSession() {}

  /// Test seam.
  void clear() {}
}
