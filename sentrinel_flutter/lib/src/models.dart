/// The wire shapes, matching the ingest contract in apps/api/src/routes/ingest.ts.
///
/// Kept deliberately close to the TypeScript `RequestLogEntry`, `ErrorPayload`
/// and `AppLogsPayload` — the server validates these, so a divergence here shows
/// up as a 400 rather than as missing data.
library;

/// One HTTP request the app made.
class RequestRecord {
  RequestRecord({
    required this.id,
    required this.method,
    required this.path,
    required this.statusCode,
    required this.responseTime,
    required this.timestamp,
    this.requestSize = 0,
    this.responseSize = 0,
    this.consumerIdentifier,
    this.errorMessage,
    this.traceId,
    this.attributes,
  });

  /// Client-generated, so logs recorded during this request can reference it.
  final String id;
  final String method;
  final String path;
  final int statusCode;

  /// Milliseconds, matching the server's `responseTime`.
  final double responseTime;
  final DateTime timestamp;
  final int requestSize;
  final int responseSize;
  final String? consumerIdentifier;
  final String? errorMessage;
  final String? traceId;

  /// Business context — screen, user tier, feature flag. Turns the row into a
  /// canonical wide event you can query on rather than a bare timing.
  final Map<String, Object?>? attributes;

  Map<String, dynamic> toJson() => {
        'id': id,
        'method': method,
        'path': path,
        'statusCode': statusCode,
        'responseTime': responseTime,
        'requestSize': requestSize,
        'responseSize': responseSize,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (consumerIdentifier != null) 'consumerIdentifier': consumerIdentifier,
        if (errorMessage != null) 'errorMessage': errorMessage,
        if (traceId != null) 'traceId': traceId,
        if (attributes != null && attributes!.isNotEmpty)
          'attributes': attributes,
        // Mobile records every request it sees; there is no sampling to declare.
        'sampleRate': 1,
      };
}

/// A failure — a non-2xx response, a thrown exception, or a crash.
class ErrorRecord {
  ErrorRecord({
    required this.method,
    required this.path,
    required this.statusCode,
    required this.timestamp,
    this.statusMessage,
    this.errorType,
    this.errorMessage,
    this.stackTrace,
    this.consumerIdentifier,
    this.requestLogId,
    this.traceId,
    this.attributes,
  });

  final String method;
  final String path;
  final int statusCode;
  final DateTime timestamp;
  final String? statusMessage;
  final String? errorType;
  final String? errorMessage;
  final String? stackTrace;
  final String? consumerIdentifier;

  /// The request this came out of, so an issue can open it.
  final String? requestLogId;
  final String? traceId;
  final Map<String, Object?>? attributes;

  Map<String, dynamic> toJson() => {
        'method': method,
        'path': path,
        'statusCode': statusCode,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (statusMessage != null) 'statusMessage': statusMessage,
        if (errorType != null) 'errorType': errorType,
        if (errorMessage != null) 'errorMessage': errorMessage,
        if (stackTrace != null) 'stackTrace': stackTrace,
        if (consumerIdentifier != null) 'consumerIdentifier': consumerIdentifier,
        if (requestLogId != null) 'requestLogId': requestLogId,
        if (traceId != null) 'traceId': traceId,
        if (attributes != null && attributes!.isNotEmpty)
          'attributes': attributes,
      };
}

/// A structured log line. Message plus fields, never an interpolated sentence —
/// the message is what groups, the attributes are what you filter on.
class LogRecord {
  LogRecord({
    required this.level,
    required this.message,
    required this.timestamp,
    this.category,
    this.attributes,
    this.requestId,
    this.traceId,
    this.spanId,
  });

  /// debug | info | warn | error
  final String level;
  final String message;
  final DateTime timestamp;
  final String? category;
  final Map<String, Object?>? attributes;
  final String? requestId;
  final String? traceId;
  final String? spanId;

  Map<String, dynamic> toJson() => {
        'level': level,
        'message': message,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (category != null) 'category': category,
        if (attributes != null && attributes!.isNotEmpty)
          'attributes': attributes,
        if (requestId != null) 'requestId': requestId,
        if (traceId != null) 'traceId': traceId,
        if (spanId != null) 'spanId': spanId,
      };
}
