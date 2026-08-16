/// Sentrinel for Flutter and Dart.
///
/// ```dart
/// void main() => Sentrinel.guard(() {
///       Sentrinel.init(
///         serverUrl: 'https://api.sentrinel.dev',
///         appName: 'mobile-app',
///         apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
///         storagePath: appSupportDir.path, // so crashes survive the crash
///       );
///
///       // Flutter catches its own errors before any zone sees them.
///       FlutterError.onError =
///           (d) => Sentrinel.flutterErrorHandler(d.exception, d.stack);
///       PlatformDispatcher.instance.onError = (e, s) {
///         Sentrinel.platformErrorHandler(e, s);
///         return true;
///       };
///
///       runApp(const MyApp());
///     });
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
import 'src/context.dart';
// `dart:io` and `dart:isolate` compile on web and then throw the moment they
// are used, so the failure surfaced here — `Directory.systemTemp` inside
// init — as `Unsupported operation: _Namespace`, with nothing in the message to
// suggest a filesystem. These resolve the platform at import time instead, so
// a browser build never reaches either library.
import 'src/device.dart';
import 'src/isolate_hook.dart';
import 'src/models.dart';
import 'src/spool.dart';
import 'src/trace.dart';

export 'src/context.dart' show Breadcrumb;
/// Pass to `Isolate.spawn(onError:)` — see the getter's own docs for why a
/// worker spawned without it reports nothing.
export 'src/isolate_hook.dart' show isolateErrorPort;
export 'src/models.dart'
    show RequestRecord, ErrorRecord, LogRecord, SessionRecord, SpanRecord;
export 'src/trace.dart' show TraceContext, generateTraceId, generateSpanId;

/// The entry point. One instance per app.
class Sentrinel {
  Sentrinel._();

  static SentrinelCollector? _collector;
  static String? _consumer;
  static Map<String, Object?> _context = {};
  static CrashSpool? _spool;
  static final BreadcrumbTrail _crumbs = BreadcrumbTrail();
  static Map<String, Object?> _device = const {};
  static IsolateErrorSubscription? _isolateErrors;
  static String? _sessionId;
  static DateTime? _sessionStartedAt;
  static String? _release;
  /// Stable across launches — see [_resolveAnonymousId].
  static String? _anonymousId;
  static String? _userId;

  /// True once [init] has been called. Every other call is a no-op until then,
  /// so a missing init degrades to "no telemetry" rather than a crash.
  static bool get isInitialised => _collector != null;

  /// Set when the previous run of the app ended without a clean shutdown.
  ///
  /// Read it to show "we noticed last time did not go well" — and note it is
  /// the honest definition: killed by the OS, force-quit and hard crash all
  /// look identical from inside the next launch.
  static bool previousRunCrashed = false;

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

    /// Where crash reports wait between the crash and the next launch.
    ///
    /// On Flutter pass `(await getApplicationSupportDirectory()).path`. Left
    /// null it falls back to the system temp directory, which works but is
    /// fair game for the OS to clear — fine for development, not for shipping.
    /// Set it to null explicitly, via [persistCrashes], to keep everything in
    /// memory.
    String? storagePath,

    /// The build this is — a version name, a git SHA, whatever you ship with.
    /// Crash-free rate is per release; without it every build is "unknown" and
    /// you cannot tell a regression from the status quo.
    String? release,

    /// Write fatal errors to disk so they survive the process. Turning this off
    /// means crashes are only reported if the app happens to live long enough
    /// for the next flush, which for a real crash it does not.
    bool persistCrashes = true,
  }) {
    _collector?.dispose();
    _consumer = consumerIdentifier;
    _device = deviceContext();
    _release = release;
    _crumbs.clear();

    _collector = SentrinelCollector(
      serverUrl: serverUrl,
      appName: appName,
      env: env,
      apiKey: apiKey,
      flushInterval: flushInterval,
      client: httpClient,
    )..start();

    if (persistCrashes) {
      _spool = CrashSpool(storagePath ?? defaultStoragePath());
      _openSession(appName, env);
      _deliverPending();
    } else {
      _spool = null;
    }

    // Product events need an identity or the server drops them, so this is
    // resolved at init rather than lazily on the first track() — an event
    // fired during startup would otherwise be the one that goes missing.
    _anonymousId = _resolveAnonymousId();
    _userId = null;
    _collector!
      ..anonymousId = _anonymousId
      ..userId = null
      ..release = release;

    _listenForIsolateErrors();
  }

  /// The install's stable anonymous id, read from disk or minted once.
  ///
  /// Without persistence every launch would be a new person: retention flat,
  /// funnels never completing across a restart, "daily actives" really meaning
  /// "daily launches". When storage is unusable this falls back to a per-run
  /// id — the events still arrive and still form funnels *within* a session,
  /// which is better than dropping them.
  static String _resolveAnonymousId() {
    final existing = _spool?.readInstallId();
    if (existing != null && existing.isNotEmpty) return existing;
    final fresh = generateTraceId();
    _spool?.writeInstallId(fresh);
    return fresh;
  }

  // ─── Product analytics ────────────────────────────────────────────────────

  /// Record that something happened: a funnel step, a feature used, a purchase.
  ///
  /// Deliberately not a log. A log line is written for a human to read while
  /// debugging; an event is a row in a funnel, counted and grouped. Sending
  /// events through [log] would either drown the funnel in debug noise or lose
  /// the events among it.
  ///
  /// ```dart
  /// Sentrinel.track('checkout_started', properties: {'cart_value': 42.0});
  /// ```
  ///
  /// Keep [properties] small — dimensions you want to group by, not a payload.
  /// The server caps them at 50 keys and 4KB; anything larger is a log.
  static void track(
    String name, {
    Map<String, Object?>? properties,
    String? traceId,
    double? durationMs,
  }) {
    if (name.trim().isEmpty) return;
    _collector?.recordEvent(EventRecord(
      name: name,
      kind: 'track',
      properties: properties,
      userId: _userId,
      sessionId: _sessionId,
      traceId: traceId,
      durationMs: durationMs,
    ));
  }

  /// Record that the user looked at a screen — the mobile pageview.
  ///
  /// The server normalises the name the same way it normalises a URL path, so
  /// `Order/8f3a…` and `Order/9b21…` count as one screen rather than as two
  /// screens seen once each. Pass the route name, not the resolved title.
  static void screen(String name, {Map<String, Object?>? properties}) {
    if (name.trim().isEmpty) return;
    _collector?.recordEvent(EventRecord(
      name: name,
      kind: 'screen',
      properties: properties,
      userId: _userId,
      sessionId: _sessionId,
    ));
  }

  /// Attach a real identity to everything from here on.
  ///
  /// Call it when someone signs in. The anonymous id is sent alongside so the
  /// server can stitch the two together: what they did *before* logging in
  /// stays attached to the same person, which is the whole point of measuring
  /// a signup funnel.
  ///
  /// Passing null signs them out — subsequent events revert to anonymous.
  static void identify(String? userId, {Map<String, Object?>? properties}) {
    _userId = (userId != null && userId.trim().isEmpty) ? null : userId;
    _collector?.userId = _userId;

    if (_userId == null) return;
    _collector?.recordEvent(EventRecord(
      name: 'identify',
      kind: 'identify',
      properties: properties,
      userId: _userId,
      sessionId: _sessionId,
    ));
  }

  /// The id product events are attributed to before anyone signs in.
  static String? get anonymousId => _anonymousId;

  /// Who events are attributed to now, or null while anonymous.
  static String? get currentUserId => _userId;

  /// Record that this run started, and notice if the last one never finished.
  static void _openSession(String appName, String env) {
    _sessionId = generateTraceId();
    _sessionStartedAt = DateTime.now();
    final previous = _spool!.beginSession({
      'sessionId': _sessionId,
      'startedAt': _sessionStartedAt!.toUtc().toIso8601String(),
      'appName': appName,
      'env': env,
      if (_release != null) 'release': _release,
      // Flipped the moment a fatal error is written, so the next launch can
      // tell a crash from a force-quit.
      'crashed': false,
    });

    // This session, reported as running. Crash-free rate needs the denominator
    // as much as the numerator — a launch that never fails still has to be
    // counted, or the rate is computed only over the crashes.
    _collector?.recordSession(SessionRecord(
      sessionId: _sessionId!,
      status: 'ok',
      startedAt: _sessionStartedAt!,
      release: _release,
      distinctId: _consumer,
      deviceOs: _device['device.os'] as String?,
      deviceOsVersion: _device['device.os_version'] as String?,
    ));

    previousRunCrashed = previous != null;
    if (previous == null) return;

    // The previous session left its marker behind, so it did not shut down
    // cleanly. Whether a crash report also arrived decides which it was: with
    // one it is `crashed` and belongs to the release; without, it is `abnormal`
    // — force-quit, OOM kill, battery — and counting that against the release
    // would make the metric dishonest.
    final crashed = previous['crashed'] == true;
    _collector?.recordSession(SessionRecord(
      sessionId: (previous['sessionId'] as String?) ?? generateTraceId(),
      status: crashed ? 'crashed' : 'abnormal',
      startedAt: DateTime.tryParse('${previous['startedAt']}')?.toLocal() ?? DateTime.now(),
      release: previous['release'] as String?,
      distinctId: _consumer,
      deviceOs: _device['device.os'] as String?,
      deviceOsVersion: _device['device.os_version'] as String?,
    ));
  }

  /// Send anything an earlier run queued to disk before it died.
  static void _deliverPending() {
    final pending = _spool!.drain();
    if (pending.isEmpty) return;
    final collector = _collector;
    if (collector == null) return;

    for (final record in pending) {
      // Replayed as-is: these were serialised at crash time and their
      // timestamps are from then, not now.
      collector.recordRaw(record.kind, record.json);
    }
  }

  /// Errors thrown on other isolates never reach a zone handler on this one.
  ///
  /// Returns without installing anything on web, which has no isolate error
  /// channel — see `isolate_hook_web.dart`.
  static void _listenForIsolateErrors() {
    _isolateErrors?.close();
    _isolateErrors = listenForIsolateErrors((error, stack) {
      captureError(error, stack, fatal: true, mechanism: 'Isolate.onError');
    });
  }

  // The port for `Isolate.spawn(onError:)` is the top-level `isolateErrorPort`,
  // exported below. It cannot live here as a `SendPort?` without importing
  // `dart:isolate` into this file, and typing it `dynamic` instead pushes an
  // analyzer error onto every caller with strict-casts on.

  /// Run the app with uncaught errors reported automatically.
  ///
  /// ```dart
  /// void main() => Sentrinel.guard(() {
  ///       Sentrinel.init(serverUrl: '…', appName: 'mobile-app');
  ///       runApp(const MyApp());
  ///     });
  /// ```
  ///
  /// This catches everything that escapes to the zone. Flutter intercepts
  /// framework errors before they get that far, so under Flutter also wire the
  /// two handlers in [flutterErrorHandler] — those live in `dart:ui` and
  /// `package:flutter`, which this package deliberately does not depend on.
  static R? guard<R>(R Function() body) {
    return runZonedGuarded<R>(body, (error, stack) {
      captureError(error, stack, fatal: true, mechanism: 'runZonedGuarded');
    });
  }

  /// Leave a marker describing something the app just did.
  ///
  /// Attached to every error reported afterwards. Navigation, taps, and the
  /// requests made by [SentrinelHttpClient] are the ones worth recording.
  static void addBreadcrumb(
    String message, {
    String category = 'app',
    Map<String, Object?>? data,
  }) {
    _crumbs.add(Breadcrumb(
      timestamp: DateTime.now(),
      category: category,
      message: message,
      data: data,
    ));
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

  /// Report an error.
  ///
  /// [fatal] is what separates a caught exception from a crash. A fatal error
  /// is written to disk **synchronously, before this returns**, because the
  /// process is about to stop existing and the next flush is thirty seconds
  /// away. Non-fatal errors take the ordinary buffered path.
  ///
  /// [mechanism] records how the error was caught — `runZonedGuarded`,
  /// `FlutterError.onError`, `Isolate.onError`, or your own call. When the same
  /// exception arrives through two handlers, this is what tells them apart.
  static void captureError(
    Object error,
    StackTrace? stack, {
    String? path,
    Map<String, Object?>? attributes,
    bool fatal = false,
    String? mechanism,
  }) {
    final collector = _collector;
    if (collector == null) return;

    final record = ErrorRecord(
      method: 'APP',
      path: path ?? (fatal ? 'app/crash' : 'app'),
      statusCode: 500,
      timestamp: DateTime.now(),
      errorType: error.runtimeType.toString(),
      errorMessage: error.toString(),
      stackTrace: stack?.toString(),
      consumerIdentifier: _consumer,
      attributes: {
        ..._device,
        ..._context,
        ...?attributes,
        if (mechanism != null) 'sentrinel.mechanism': mechanism,
        if (fatal) 'sentrinel.fatal': true,
        if (_sessionId != null) 'session.id': _sessionId,
        if (_crumbs.length > 0) 'breadcrumbs': _crumbs.toJson(),
      },
    );

    final spool = _spool;
    if (fatal && spool != null) {
      // On disk first. If the app dies on the next line the report still ships
      // on the next launch; the buffered copy below is just the fast path for
      // the case where it survives.
      spool.appendSync('error', record.toJson());
      // And mark the session, so the next launch reports `crashed` rather than
      // the vaguer `abnormal`.
      spool.markSessionCrashed();
      return;
    }
    collector.recordError(record);
  }

  /// Hand a Flutter framework error to Sentrinel.
  ///
  /// Flutter catches errors inside its own build/layout/paint phases before any
  /// zone sees them, so [guard] alone does not cover them. Wiring is two lines,
  /// and stays in your app because the types live in `package:flutter` and
  /// `dart:ui` — dependencies this package does not take, so that it keeps
  /// working in plain Dart:
  ///
  /// ```dart
  /// FlutterError.onError = (details) =>
  ///     Sentrinel.flutterErrorHandler(details.exception, details.stack);
  ///
  /// PlatformDispatcher.instance.onError = (error, stack) {
  ///   Sentrinel.platformErrorHandler(error, stack);
  ///   return true;
  /// };
  /// ```
  static void flutterErrorHandler(Object error, StackTrace? stack) =>
      captureError(error, stack, fatal: true, mechanism: 'FlutterError.onError');

  /// The companion for errors that escape to the engine — see
  /// [flutterErrorHandler].
  static void platformErrorHandler(Object error, StackTrace? stack) => captureError(
        error,
        stack,
        fatal: true,
        mechanism: 'PlatformDispatcher.onError',
      );

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

  /// Shut down cleanly.
  ///
  /// Clearing the session marker is what makes crash detection mean anything:
  /// without it every ordinary exit would look, on the next launch, exactly
  /// like a crash.
  static Future<void> close() async {
    // Recorded *before* stop(), because stop() performs the final flush. Queued
    // after it, the closing session would sit in a buffer belonging to a
    // collector that is never going to send anything again.
    if (_sessionId != null && _sessionStartedAt != null) {
      _collector?.recordSession(SessionRecord(
        sessionId: _sessionId!,
        status: 'ok',
        startedAt: _sessionStartedAt!,
        release: _release,
        distinctId: _consumer,
        deviceOs: _device['device.os'] as String?,
        deviceOsVersion: _device['device.os_version'] as String?,
        durationMs:
            DateTime.now().difference(_sessionStartedAt!).inMilliseconds.toDouble(),
      ));
    }

    await _collector?.stop();
    _collector?.dispose();
    _collector = null;
    _isolateErrors?.close();
    _isolateErrors = null;
    _spool?.endSession();
    _spool = null;
    _sessionId = null;
    _sessionStartedAt = null;
    _crumbs.clear();
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

      final path = request.url.path.isEmpty ? '/' : request.url.path;

      collector.recordRequest(RequestRecord(
        id: id,
        method: request.method,
        path: path,
        statusCode: response.statusCode,
        responseTime: watch.elapsedMicroseconds / 1000.0,
        timestamp: started,
        requestSize: request.contentLength ?? 0,
        responseSize: response.contentLength ?? 0,
        consumerIdentifier: Sentrinel.consumer,
        traceId: trace.traceId,
        attributes: Sentrinel.context.isEmpty ? null : {...Sentrinel.context},
      ));

      // The client half of the waterfall. Its id is the one that went out on
      // `traceparent`, so the server's span names it as parent and the two
      // halves render as one tree. The difference between this duration and
      // the server's is the network.
      collector.recordSpan(SpanRecord(
        id: trace.spanId,
        traceId: trace.traceId,
        name: '${request.method} $path',
        startTime: started,
        durationMs: watch.elapsedMicroseconds / 1000.0,
        statusCode: response.statusCode >= 500 ? 'ERROR' : 'OK',
        attributes: {
          'http.method': request.method,
          'http.url': request.url.toString(),
          'http.status_code': response.statusCode,
          if (Sentrinel.consumer != null) 'sentrinel.consumer': Sentrinel.consumer,
        },
      ));

      // Left automatically, because a breadcrumb trail you have to remember to
      // fill is empty in exactly the app that just crashed.
      Sentrinel.addBreadcrumb(
        '${request.method} ${request.url.path.isEmpty ? '/' : request.url.path}',
        category: 'http',
        data: {
          'status': response.statusCode,
          'ms': (watch.elapsedMicroseconds / 1000).round(),
        },
      );

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
      Sentrinel.addBreadcrumb(
        '${request.method} ${request.url.path.isEmpty ? '/' : request.url.path} failed',
        category: 'http',
        data: {'error': err.runtimeType.toString()},
      );
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
