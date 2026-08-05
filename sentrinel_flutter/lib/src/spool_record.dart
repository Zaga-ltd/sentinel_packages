/// The one spool type that is the same everywhere.
///
/// Kept out of the platform implementations so `spool_io.dart` and
/// `spool_web.dart` describe the same record rather than two structurally
/// identical ones that the analyser would treat as unrelated.
library;

/// One queued record, as read back from storage.
class SpooledRecord {
  SpooledRecord(this.kind, this.json);

  /// "error", "log" or "request" — which ingest endpoint it belongs to.
  final String kind;
  final Map<String, dynamic> json;
}
