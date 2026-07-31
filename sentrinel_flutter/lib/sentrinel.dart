/// Sentrinel for Flutter and Dart.
///
/// ```dart
/// void main() {
///   Sentrinel.init(
///     serverUrl: 'https://api.sentrinel.dev',
///     appName: 'mobile-app',
///     apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
///   );
///   runApp(const MyApp());
/// }
/// ```
///
/// Then wrap your HTTP client and every call is recorded:
///
/// ```dart
/// final client = Sentrinel.httpClient();
/// final res = await client.get(Uri.parse('https://api.example.com/orders'));
/// ```
///
/// The wrapper sends `traceparent`, so the backend plugin continues the same
/// trace rather than starting a new one — the tap and the server work it caused
/// end up on one timeline.
library;

import 'dart:async';

import 'package:http/http.dart' as http;

import 'src/collector.dart';
import 'src/models.dart';
import 'src/trace.dart';

export 'src/models.dart' show RequestRecord, ErrorRecord, LogRecord;
export 'src/trace.dart' show TraceContext, generateTraceId, generateSpanId;

/// The entry point. One instance per app.
class Sentrinel {
  Sentrinel._();

  static SentrinelCollector? _collector;
  static String? _consumer;
  static Map<String, Object?> _context = {};

  /// True once [init] has been called. Every other call is a no-op until then,
  /// so a missing init degrades to "no telemetry" rather than a crash.
  static bool get isInitialised => _collector != null;

  static void init({
    required String serverUrl,
    required String appName,
    String env = 'prod',
    String? apiKey,
    Duration flushInterval = const Duration(seconds: 30),
    /// Identifies this client in Consumers — a user id, a tenant, a build
    /// channel. Whatever you want to slice traffic by.
    String? consumerIdentifier,
    http.Client? httpClient,
  }) {
    _collector?.dispose();
    _consumer = consumerIdentifier;
    _collector = SentrinelCollector(
      serverUrl: serverUrl,
      appName: appName,
      env: env,
      apiKey: apiKey,
      flushInterval: flushInterval,
      client: httpClient,
    )..start();
  }

  /// Fields attached to every subsequent record — screen, user tier, build.
  /// Set once where you know them; they reach records written by code that has
  /// never heard of a user.
  static void setContext(Map<String, Object?> fields) {
    _context = {..._context, ...fields};
  }

  static void clearContext() => _context = {};

  /// A client that records everything it sends.
  ///
  /// Wrap your own if you have one; otherwise this creates a plain one.
  static http.Client httpClient({http.Client? inner}) =>
      SentrinelHttpClient(inner ?? http.Client());

  /// Report a caught error, or a crash from your zone handler.
  static void captureError(
    Object error,
    StackTrace? stack, {
    String? path,
    Map<String, Object?>? attributes,
  }) {
    final collector = _collector;
    if (collector == null) return;
    collector.recordError(ErrorRecord(
      method: 'APP',
      path: path ?? 'app',
      statusCode: 500,
      timestamp: DateTime.now(),
      errorType: error.runtimeType.toString(),
      errorMessage: error.toString(),
      stackTrace: stack?.toString(),
      consumerIdentifier: _consumer,
      attributes: {..._context, ...?attributes},
    ));
  }

  static void log(
    String level,
    String message, {
    String? category,
    Map<String, Object?>? attributes,
  }) {
    final collector = _collector;
    if (collector == null) return;
    collector.recordLog(LogRecord(
      level: level,
      message: message,
      timestamp: DateTime.now(),
      category: category,
      attributes: {..._context, ...?attributes},
    ));
  }

  static void debug(String m, {String? category, Map<String, Object?>? attributes}) =>
      log('debug', m, category: category, attributes: attributes);
  static void info(String m, {String? category, Map<String, Object?>? attributes}) =>
      log('info', m, category: category, attributes: attributes);
  static void warn(String m, {String? category, Map<String, Object?>? attributes}) =>
      log('warn', m, category: category, attributes: attributes);
  static void error(String m, {String? category, Map<String, Object?>? attributes}) =>
      log('error', m, category: category, attributes: attributes);

  /// Send whatever is buffered now. Worth calling from `AppLifecycleState.paused`
  /// — a backgrounded app may not get another timer tick.
  static Future<void> flush() async => _collector?.flush();

  static Future<void> close() async {
    await _collector?.stop();
    _collector?.dispose();
    _collector = null;
  }

  // ── internals used by the client wrapper ──
  static SentrinelCollector? get collector => _collector;
  static String? get consumer => _consumer;
  static Map<String, Object?> get context => _context;
}

/// An [http.Client] that records every request and propagates trace context.
class SentrinelHttpClient extends http.BaseClient {
  SentrinelHttpClient(this._inner);

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final collector = Sentrinel.collector;
    if (collector == null) return _inner.send(request);

    final trace = TraceContext();
    // Only set it if the caller has not — an app already doing its own
    // propagation should win.
    request.headers.putIfAbsent('traceparent', () => trace.traceparent);

    final id = generateTraceId();
    final started = DateTime.now();
    final watch = Stopwatch()..start();

    try {
      final response = await _inner.send(request);
      watch.stop();

      collector.recordRequest(RequestRecord(
        id: id,
        method: request.method,
        path: request.url.path.isEmpty ? '/' : request.url.path,
        statusCode: response.statusCode,
        responseTime: watch.elapsedMicroseconds / 1000.0,
        timestamp: started,
        requestSize: request.contentLength ?? 0,
        responseSize: response.contentLength ?? 0,
        consumerIdentifier: Sentrinel.consumer,
        traceId: trace.traceId,
        attributes: Sentrinel.context.isEmpty ? null : {...Sentrinel.context},
      ));

      if (response.statusCode >= 400) {
        collector.recordError(ErrorRecord(
          method: request.method,
          path: request.url.path.isEmpty ? '/' : request.url.path,
          statusCode: response.statusCode,
          timestamp: started,
          consumerIdentifier: Sentrinel.consumer,
          requestLogId: id,
          traceId: trace.traceId,
          attributes: Sentrinel.context.isEmpty ? null : {...Sentrinel.context},
        ));
      }
      return response;
    } catch (err, stack) {
      watch.stop();
      // A transport failure never reached a server, so there is no status. 0
      // says "did not complete" rather than inventing a 5xx the server never
      // sent.
      collector.recordRequest(RequestRecord(
        id: id,
        method: request.method,
        path: request.url.path.isEmpty ? '/' : request.url.path,
        statusCode: 0,
        responseTime: watch.elapsedMicroseconds / 1000.0,
        timestamp: started,
        consumerIdentifier: Sentrinel.consumer,
        errorMessage: err.toString(),
        traceId: trace.traceId,
      ));
      collector.recordError(ErrorRecord(
        method: request.method,
        path: request.url.path.isEmpty ? '/' : request.url.path,
        statusCode: 0,
        timestamp: started,
        errorType: err.runtimeType.toString(),
        errorMessage: err.toString(),
        stackTrace: stack.toString(),
        consumerIdentifier: Sentrinel.consumer,
        requestLogId: id,
        traceId: trace.traceId,
      ));
      rethrow;
    }
  }

  @override
  void close() {
    _inner.close();
    super.close();
  }
}
