/// The wire shapes, matching the ingest contract in apps/api/src/routes/ingest.ts.
///
/// Kept deliberately close to the TypeScript `RequestLogEntry`, `ErrorPayload`
/// and `AppLogsPayload` — the server validates these, so a divergence here shows
/// up as a 400 rather than as missing data.
library;

/// One HTTP request the app made.
class RequestRecord {
  RequestRecord({
    this.route,
    this.host,
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

  /// The route template this call matched — `/orders/{id}`, not `/orders/8f3a`.
  ///
  /// `path` cannot serve both purposes. Grouping by it makes one endpoint per
  /// distinct id, which is an unbounded endpoints table and an "active
  /// endpoints" count in the hundreds for an app that calls thirty routes.
  /// Derived automatically by replacing id-shaped segments; pass it explicitly
  /// when the guess is wrong.
  final String? route;

  /// The host that was called. With one app talking to several services, "it
  /// is slow" and "that service is slow" look identical without this.
  final String? host;

  Map<String, dynamic> toJson() => {
        'id': id,
        'method': method,
        'path': path,
        'statusCode': statusCode,
        'responseTime': responseTime,
        'requestSize': requestSize,
        'responseSize': responseSize,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (route != null) 'route': route,
        if (host != null) 'host': host,
        if (consumerIdentifier != null) 'consumerIdentifier': consumerIdentifier,
        if (errorMessage != null) 'errorMessage': errorMessage,
        if (traceId != null) 'traceId': traceId,
        if (attributes != null && attributes!.isNotEmpty)
          'attributes': attributes,
        // Mobile records every request it sees; there is no sampling to declare.
        'sampleRate': 1,
      };
}

/// One app launch — the denominator for crash-free rate.
///
/// Reported twice: once when it starts, and once when it ends or is found
/// abandoned by the next launch. The server upserts on `sessionId` and only
/// ever lets the status get worse, so the order they arrive in does not matter.
class SessionRecord {
  SessionRecord({
    required this.sessionId,
    required this.status,
    required this.startedAt,
    this.release,
    this.distinctId,
    this.deviceOs,
    this.deviceOsVersion,
    this.durationMs,
  });

  final String sessionId;

  /// `ok` · `crashed` · `abnormal` · `errored`.
  ///
  /// `abnormal` is the honest label for a session that vanished without a crash
  /// report: force-quit, OOM kill, battery. Blaming a release for a user
  /// swiping the app away would make crash-free rate meaningless.
  final String status;

  final DateTime startedAt;
  final String? release;
  final String? distinctId;
  final String? deviceOs;
  final String? deviceOsVersion;
  final double? durationMs;

  Map<String, dynamic> toJson() => {
        'sessionId': sessionId,
        'status': status,
        'startedAt': startedAt.toUtc().toIso8601String(),
        if (release != null) 'release': release,
        if (distinctId != null) 'distinctId': distinctId,
        if (deviceOs != null) 'deviceOs': deviceOs,
        if (deviceOsVersion != null) 'deviceOsVersion': deviceOsVersion,
        if (durationMs != null) 'durationMs': durationMs,
      };

  SessionRecord copyWith({String? status, double? durationMs}) => SessionRecord(
        sessionId: sessionId,
        status: status ?? this.status,
        startedAt: startedAt,
        release: release,
        distinctId: distinctId,
        deviceOs: deviceOs,
        deviceOsVersion: deviceOsVersion,
        durationMs: durationMs ?? this.durationMs,
      );
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
    this.consumerIdentifier,
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

  /// Whose activity produced this line.
  ///
  /// Stored on the row rather than resolved through [requestId] at read time:
  /// logs and requests expire on separate clocks, and a line whose request has
  /// aged out would otherwise lose its owner entirely — so "everything this
  /// user did" would quietly return a subset.
  final String? consumerIdentifier;

  final String? category;
  final Map<String, Object?>? attributes;
  final String? requestId;
  final String? traceId;
  final String? spanId;

  Map<String, dynamic> toJson() => {
        'level': level,
        'message': message,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (consumerIdentifier != null) 'consumerIdentifier': consumerIdentifier,
        if (category != null) 'category': category,
        if (attributes != null && attributes!.isNotEmpty)
          'attributes': attributes,
        if (requestId != null) 'requestId': requestId,
        if (traceId != null) 'traceId': traceId,
        if (spanId != null) 'spanId': spanId,
      };
}

/// One span of work, for the trace waterfall.
///
/// The app sends `traceparent` on every request, so the backend already
/// continues the same trace. What was missing is this: the client's own span.
/// Without it the waterfall starts at the server, and the time between the tap
/// and the first byte the server saw — DNS, TLS, the radio, a cold connection —
/// is invisible, which is usually the part being argued about.
class SpanRecord {
  SpanRecord({
    required this.id,
    required this.traceId,
    required this.name,
    required this.startTime,
    required this.durationMs,
    this.parentId,
    this.kind = 'CLIENT',
    this.statusCode = 'OK',
    this.attributes,
  });

  final String id;
  final String traceId;
  final String? parentId;
  final String name;
  final String kind;
  final DateTime startTime;
  final double durationMs;
  final String statusCode;
  final Map<String, Object?>? attributes;

  Map<String, dynamic> toJson() => {
        'id': id,
        'traceId': traceId,
        'parentId': parentId,
        'name': name,
        'kind': kind,
        'startTime': startTime.toUtc().toIso8601String(),
        'endTime': startTime
            .add(Duration(microseconds: (durationMs * 1000).round()))
            .toUtc()
            .toIso8601String(),
        'durationMs': durationMs,
        'statusCode': statusCode,
        // `sentrinel.source` is what lets the waterfall say which tier a span
        // ran on. Set here rather than inferred from `kind`: a CLIENT span is
        // emitted by a phone, a browser and a backend calling another service
        // alike, and those are three different answers.
        'attributes': {
          'sentrinel.source': 'mobile',
          ...?attributes,
        },
      };
}

/// A product event — a screen view, a funnel step, a signup.
///
/// Separate from [LogRecord] on purpose. A log line is written for a human to
/// read while debugging; an event is a row in a funnel, counted and grouped.
/// Conflating them means either drowning the funnel in debug noise or losing
/// the events among it.
class EventRecord {
  EventRecord({
    required this.name,
    this.kind = 'track',
    this.properties,
    this.userId,
    this.sessionId,
    this.traceId,
    this.durationMs,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();

  /// What happened: `checkout_started`, `Cart`, `signup_completed`.
  final String name;

  /// `track` · `screen` · `identify` · `session_start`.
  ///
  /// `screen` is the mobile equivalent of a pageview, and the server
  /// normalises its name the same way — so `Order/8f3a…` and `Order/9b21…`
  /// count as one screen rather than as two screens seen once each.
  final String kind;

  /// Dimensions to group and filter by. Kept small deliberately: the server
  /// caps a payload at 50 keys and 4KB, and anything larger is a log, not an
  /// event.
  final Map<String, Object?>? properties;

  /// Set once [Sentrinel.identify] has been called. Before that an event
  /// carries only the anonymous id, and the server stitches the two together
  /// when the identify arrives.
  final String? userId;

  final String? sessionId;
  final String? traceId;
  final double? durationMs;
  final DateTime timestamp;

  Map<String, dynamic> toJson() => {
        'name': name,
        'kind': kind,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (properties != null && properties!.isNotEmpty) 'properties': properties,
        if (userId != null) 'userId': userId,
        if (sessionId != null) 'sessionId': sessionId,
        if (traceId != null) 'traceId': traceId,
        if (durationMs != null) 'durationMs': durationMs,
      };
}

/// Collapse the ids out of a URL path so it groups as one endpoint.
///
/// A mobile app calls `/orders/8f3a…` and `/orders/9b21…`; the server keys
/// endpoints on `route || path`, so without this each id becomes an endpoint
/// of its own — an unbounded endpoints table, and an "active endpoints" count
/// in the hundreds for an app that calls thirty routes.
///
/// The rules are deliberately conservative: a segment is replaced only when it
/// is *obviously* an identifier. Collapsing `/v1/` into `/{id}/` would be far
/// worse than leaving a stray id in place, because it merges endpoints that
/// have nothing to do with each other.
String routeTemplate(String path) {
  if (path.isEmpty) return '/';

  final segments = path.split('/');
  for (var i = 0; i < segments.length; i++) {
    final seg = segments[i];
    if (seg.isEmpty) continue;
    if (_looksLikeId(seg)) segments[i] = '{id}';
  }
  final out = segments.join('/');
  return out.isEmpty ? '/' : out;
}

final _uuid = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
final _digits = RegExp(r'^\d+$');
// 8+ is where short SHAs and compact ids live. Shorter than that and the false
// positives start costing more than the collapsing saves.
final _hex = RegExp(r'^[0-9a-fA-F]{8,}$');
// Mixed-case alphanumerics of some length: ULIDs, nanoids, Stripe-style ids.
final _opaque = RegExp(r'^[A-Za-z0-9_-]{16,}$');
final _hasDigit = RegExp(r'\d');

bool _looksLikeId(String seg) {
  if (_uuid.hasMatch(seg)) return true;
  if (_digits.hasMatch(seg)) return true;

  // Every remaining rule insists on a digit, and that is what keeps ordinary
  // words safe. `facade`, `decade` and `defaced` are all valid hex; `orders`
  // and `notifications` are long enough to look opaque. Merging any of those
  // into `{id}` would fuse unrelated endpoints — far worse than leaving one
  // stray id uncollapsed.
  if (!_hasDigit.hasMatch(seg)) return false;

  if (_hex.hasMatch(seg)) return true;
  if (_opaque.hasMatch(seg)) return true;
  return false;
}
