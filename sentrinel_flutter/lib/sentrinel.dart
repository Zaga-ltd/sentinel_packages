/// Sentrinel for Flutter and Dart.
///
/// ```dart
/// void main() => Sentrinel.guard(() {
///       Sentrinel.init(
///         serverUrl: 'https://api.sentrinel.dev',
///         appName: 'mobile-app',
///         apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
///         storagePath: appSupportDir.path, // so crashes survive the crash
///         // Your own backends: they receive traceparent and the
///         // consumer/device headers. Nothing else does.
///         tracePropagationTargets: ['api.example.com'],
///       );
///
///       // Flutter catches its own errors before any zone sees them.
///       FlutterError.onError = (d) => Sentrinel.flutterErrorHandler(
///           d.exception, d.stack, silent: d.silent);
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
/// For hosts in `tracePropagationTargets` the wrapper sends `traceparent`, so
/// the backend plugin continues the same trace rather than starting a new one
/// — the tap and the server work it caused end up on one timeline.
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
import 'src/device_facts.dart';
import 'src/isolate_hook.dart';
import 'src/models.dart';
import 'src/redact.dart';
import 'src/spool.dart';
import 'src/trace.dart';

export 'src/collector.dart' show BeforeSend;
export 'src/context.dart' show Breadcrumb;
export 'src/device_facts.dart' show kSdkName, kSdkVersion;
/// Pass to `Isolate.spawn(onError:)` — see the getter's own docs for why a
/// worker spawned without it reports nothing.
export 'src/isolate_hook.dart' show isolateErrorPort;
export 'src/models.dart'
    show
        RequestRecord,
        ErrorRecord,
        LogRecord,
        SessionRecord,
        SpanRecord,
        normaliseRoutePath;
export 'src/redact.dart' show sanitizeUrl, scrubUrls;
export 'src/trace.dart' show TraceContext, generateTraceId, generateSpanId;
export 'src/metrics.dart' show MetricRegistry, kMaxSeries, kMaxSamples;

/// How bad a session got. Only ever moves forward, like the server's rule.
const _sessionRank = {'ok': 0, 'errored': 1, 'crashed': 3};

/// The entry point. One instance per app.
class Sentrinel {
  Sentrinel._();

  static SentrinelCollector? _collector;

  /// Set by [setConsumer], or by `consumerIdentifier` at init. Wins over
  /// everything until [identify] or `setConsumer(null)` clears it.
  static String? _consumerOverride;
  static Map<String, Object?> _context = {};

  /// The storage directory: the install id always, crash reports and the
  /// session marker when [init]'s `persistCrashes` is on.
  static CrashSpool? _spool;
  static bool _persistCrashes = false;
  static final BreadcrumbTrail _crumbs = BreadcrumbTrail();
  static Map<String, Object?> _device = const {};

  /// What `dart:io` knows, overlaid with what [setDeviceInfo] was told.
  static DeviceFacts _facts = const DeviceFacts();
  static DeviceFacts _factsOverride = const DeviceFacts();
  static IsolateErrorSubscription? _isolateErrors;
  static String? _appName;
  static String? _env;
  static String? _sessionId;
  static DateTime? _sessionStartedAt;
  static String _sessionStatus = 'ok';
  static DateTime? _backgroundedAt;
  static String? _release;
  static List<Object> _propagationTargets = const [];

  /// Stable across launches — see [_resolveAnonymousId].
  static String? _anonymousId;
  static String? _userId;

  /// How long the app may sit in the background and still be the same
  /// session when it returns. Past it, returning starts a new one.
  static Duration sessionTimeout = const Duration(seconds: 30);

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

    /// Which part of the project this is. An app in Sentrinel is the whole
    /// project — the phone, the backend, the web client — and each reports as
    /// a module of it, so one request can be followed across all of them.
    /// Unset, the API key's name is used.
    String? module,
    Duration flushInterval = const Duration(seconds: 30),

    /// Pins the consumer to a fixed value — a tenant, a kiosk, an API client —
    /// until [identify] or [setConsumer] changes it.
    ///
    /// Usually leave it out. Signed-out traffic is then filed under
    /// `guest:<install id>`, one consumer per install, and [identify] moves it
    /// to the signed-in user. Passing a platform here ("mobile_android") used
    /// to file every signed-out user as one person.
    String? consumerIdentifier,

    /// Used for telemetry posts. A client you pass is yours: it is not closed
    /// when Sentrinel shuts down or is re-initialised.
    http.Client? httpClient,

    /// Where crash reports and the install id live between launches.
    ///
    /// On Flutter pass `(await getApplicationSupportDirectory()).path` — the
    /// `sentrinel_flutter` package does. Left null it falls back to the system
    /// temp directory, which works but is fair game for the OS to clear — fine
    /// for development, not for shipping.
    String? storagePath,

    /// The build this is — a version name, a git SHA, whatever you ship with.
    /// Crash-free rate is per release; without it every build is "unknown" and
    /// you cannot tell a regression from the status quo.
    String? release,

    /// Write fatal errors and the session marker to disk so they survive the
    /// process. Off, a fatal error is sent straight away and nothing but the
    /// install id touches the disk; a crash then reaches the server only if
    /// the process lives long enough to send it.
    bool persistCrashes = true,

    /// Which hosts receive `traceparent`, `x-sentrinel-consumer` and
    /// `x-sentrinel-device` from [httpClient].
    ///
    /// A `String` is a host: `api.example.com` matches it and its subdomains,
    /// `*.example.com` only subdomains, and a value with `://` is a URL prefix.
    /// A `RegExp` is matched against the full URL. Empty by default — a
    /// third-party API (payments, maps, analytics) must not be sent your trace
    /// ids or your user's id. On web, same-origin calls always qualify.
    List<Object>? tracePropagationTargets,

    /// Rewrite or drop any record before it is sent or stored. See
    /// [BeforeSend].
    BeforeSend? beforeSend,
  }) {
    // Initialising again replaces the collector — but the old one's buffer is
    // sent, not thrown away, and its session closes cleanly rather than being
    // reported as abnormal by the new one. An old collector that was already
    // disposed is a process that died; that one is left exactly as it is.
    final old = _collector;
    if (old != null && !old.isDisposed) {
      _endSession(old);
      unawaited(old.stop().whenComplete(old.dispose));
    }
    _collector = null;
    _isolateErrors?.close();
    _isolateErrors = null;

    final pinned = consumerIdentifier?.trim();
    _consumerOverride = (pinned == null || pinned.isEmpty) ? null : pinned;
    _device = deviceContext();
    _facts = _mergeFacts();
    _release = release;
    _appName = appName;
    _env = env;
    _crumbs.clear();
    _propagationTargets = List.unmodifiable(tracePropagationTargets ?? const <Object>[]);
    _sessionStatus = 'ok';
    _backgroundedAt = null;

    final spool = CrashSpool(storagePath ?? defaultStoragePath());
    _spool = spool;
    _persistCrashes = persistCrashes;

    // Resolved before anything is recorded: the session row, the first
    // request and the first event all name this install.
    _anonymousId = _resolveAnonymousId(spool);
    _userId = null;

    final collector = SentrinelCollector(
      serverUrl: serverUrl,
      appName: appName,
      env: env,
      apiKey: apiKey,
      module: module,
      flushInterval: flushInterval,
      client: httpClient,
      userAgent: runningOnWeb ? null : sdkUserAgent(_facts),
      beforeSend: beforeSend,
    )
      ..anonymousId = _anonymousId
      ..userId = null
      ..release = release
      ..device = _facts
      // Bound to *this* spool: a flush of the collector this init replaced
      // may still be in flight, and its acknowledgements belong to its own.
      ..onDelivered = spool.acknowledge;
    _collector = collector..start();

    _openSession(collector, spool);
    if (persistCrashes) _deliverPending(collector, spool);

    _listenForIsolateErrors();
  }

  /// The install's stable anonymous id, read from disk or minted once.
  ///
  /// Without persistence every launch would be a new person: retention flat,
  /// funnels never completing across a restart, "daily actives" really meaning
  /// "daily launches". When storage is unusable this falls back to a per-run
  /// id — the events still arrive and still form funnels *within* a session,
  /// which is better than dropping them.
  static String _resolveAnonymousId(CrashSpool spool) {
    final existing = spool.readInstallId();
    if (existing != null && existing.isNotEmpty) return existing;
    final fresh = generateTraceId();
    spool.writeInstallId(fresh);
    return fresh;
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  /// This install's id: the same across launches, different on every device.
  ///
  /// Sent on every record as `device.id`, as the `x-sentrinel-device` header to
  /// your own backends, and as the `guest:` consumer while nobody is signed
  /// in.
  static String? get deviceId => _anonymousId;

  /// The id product events are attributed to before anyone signs in. The
  /// same value as [deviceId].
  static String? get anonymousId => _anonymousId;

  /// Who events are attributed to now, or null while anonymous.
  static String? get currentUserId => _userId;

  /// Who requests, errors and logs are filed under on the Consumers page.
  ///
  /// The signed-in user after [identify]; `guest:<install id>` before it, so
  /// each signed-out install is its own consumer rather than every one of them
  /// sharing a single bucket; a pinned value after [setConsumer].
  static String? get consumer =>
      _consumerOverride ?? _userId ?? (_anonymousId == null ? null : 'guest:$_anonymousId');

  /// Attach a real identity to everything from here on.
  ///
  /// Call it after sign-in, at launch when a saved session is restored, and
  /// after the profile changes. The anonymous id is sent alongside so the
  /// server can stitch the two together: what they did *before* logging in
  /// stays attached to the same person, which is the whole point of measuring
  /// a signup funnel.
  ///
  /// Passing null signs them out: traffic returns to `guest:<install id>`.
  /// Identifying someone is the statement that this traffic is theirs, so it
  /// also clears a consumer pinned by [setConsumer] or `consumerIdentifier`.
  static void identify(String? userId, {Map<String, Object?>? properties}) {
    final trimmed = userId?.trim();
    _userId = (trimmed == null || trimmed.isEmpty) ? null : trimmed;
    _consumerOverride = null;
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

  /// Attribute this app's traffic to something other than the signed-in user.
  ///
  /// [identify] covers the usual case. Reach for this when the thing you want
  /// on the Consumers page is not the person — a tenant, a kiosk, an API
  /// client. Passing null un-pins it: back to the signed-in user, or to
  /// `guest:<install id>`.
  static void setConsumer(String? identifier) {
    final trimmed = identifier?.trim();
    _consumerOverride = (trimmed == null || trimmed.isEmpty) ? null : trimmed;
  }

  /// Tell Sentrinel what `dart:io` cannot see.
  ///
  /// Plain Dart knows the OS and, on iOS, its version. The model, Android's
  /// version and whether this is a tablet need a plugin — feed them from
  /// `device_info_plus`:
  ///
  /// ```dart
  /// final info = await DeviceInfoPlugin().androidInfo;
  /// Sentrinel.setDeviceInfo(model: info.model, osVersion: info.version.release);
  /// ```
  ///
  /// [deviceType] is `mobile`, `tablet` or `desktop`; the Flutter package sets
  /// it from the screen size on its own.
  static void setDeviceInfo({
    String? model,
    String? osVersion,
    String? deviceType,
    String? os,
  }) {
    _factsOverride = _factsOverride.merge(
      deviceModel: _blankToNull(model),
      osVersion: _blankToNull(osVersion),
      deviceType: _blankToNull(deviceType),
      os: _blankToNull(os),
    );
    _facts = _mergeFacts();
    final collector = _collector;
    if (collector == null) return;
    collector
      ..device = _facts
      ..userAgent = runningOnWeb ? null : sdkUserAgent(_facts);
    // The session row carries the OS too; resend it with the better answer.
    if (_sessionId != null) collector.recordSession(_sessionRecord());
  }

  static DeviceFacts _mergeFacts() => platformFacts().merge(
        os: _factsOverride.os,
        osVersion: _factsOverride.osVersion,
        deviceType: _factsOverride.deviceType,
        deviceModel: _factsOverride.deviceModel,
      );

  static String? _blankToNull(String? v) => (v == null || v.trim().isEmpty) ? null : v.trim();

  /// The device, for the attributes of every record.
  static Map<String, Object?> get _deviceAttributes => {
        ..._device,
        if (_facts.deviceModel != null) 'device.model': _facts.deviceModel,
        if (_facts.deviceType != null) 'device.type': _facts.deviceType,
        if (_anonymousId != null) 'device.id': _anonymousId,
      };

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

  // ── Custom metrics ──
  //
  // The numbers only this app knows: videos watched, seconds buffered, items
  // added. Increments fold in memory and leave as one row per series per
  // flush, so calling these in a build method or a scroll listener is a normal
  // thing to do rather than something to be careful about.

  /// Add to a running total: items sold, retries, videos started.
  static void count(String name, [num value = 1, Map<String, Object?>? labels, String? unit]) =>
      _collector?.metrics.record(name, 'counter', value, labels: labels, unit: unit);

  /// Report a level that goes up and down: queue depth, cache size.
  ///
  /// The last value in a flush window wins — a gauge is a reading, not a total.
  static void gauge(String name, num value, [Map<String, Object?>? labels, String? unit]) =>
      _collector?.metrics.record(name, 'gauge', value, labels: labels, unit: unit);

  /// Record a distribution: time to first frame of a video, payload size.
  ///
  /// Percentiles come back with it, which is the point — an average hides the
  /// one user whose experience was fifty times worse.
  static void histogram(String name, num value, [Map<String, Object?>? labels, String? unit]) =>
      _collector?.metrics.record(name, 'histogram', value, labels: labels, unit: unit);

  // ─── Sessions ─────────────────────────────────────────────────────────────

  static Map<String, dynamic> _sessionMarker() => {
        'sessionId': _sessionId,
        'startedAt': _sessionStartedAt!.toUtc().toIso8601String(),
        'appName': _appName,
        'env': _env,
        if (_release != null) 'release': _release,
        if (consumer != null) 'distinctId': consumer,
        // Flipped the moment a fatal error is written, so the next launch can
        // tell a crash from a force-quit.
        'crashed': _sessionStatus == 'crashed',
      };

  static SessionRecord _sessionRecord({double? durationMs}) => SessionRecord(
        sessionId: _sessionId!,
        status: _sessionStatus,
        startedAt: _sessionStartedAt!,
        release: _release,
        distinctId: consumer,
        deviceOs: _facts.os,
        deviceOsVersion: _facts.osVersion,
        durationMs: durationMs,
      );

  static double _sessionDurationMs() =>
      DateTime.now().difference(_sessionStartedAt!).inMilliseconds.toDouble();

  /// Record that this run started, and notice if the last one never finished.
  static void _openSession(SentrinelCollector collector, CrashSpool spool) {
    _sessionId = generateTraceId();
    _sessionStartedAt = DateTime.now();
    _sessionStatus = 'ok';
    final previous = _persistCrashes ? spool.beginSession(_sessionMarker()) : null;

    // This session, reported as running. Crash-free rate needs the denominator
    // as much as the numerator — a launch that never fails still has to be
    // counted, or the rate is computed only over the crashes.
    collector.recordSession(_sessionRecord());

    previousRunCrashed = previous != null;
    if (previous == null) return;

    // The previous session left its marker behind, so it did not shut down
    // cleanly. Whether a crash report also arrived decides which it was: with
    // one it is `crashed` and belongs to the release; without, it is `abnormal`
    // — force-quit, OOM kill, battery — and counting that against the release
    // would make the metric dishonest.
    //
    // The owner is the one the marker recorded, or none: the server keeps the
    // one it already has. Filing a dead session under whoever launched the
    // app *this* time would move it between people.
    final crashed = previous['crashed'] == true;
    collector.recordSession(SessionRecord(
      sessionId: (previous['sessionId'] as String?) ?? generateTraceId(),
      status: crashed ? 'crashed' : 'abnormal',
      startedAt: DateTime.tryParse('${previous['startedAt']}')?.toLocal() ?? DateTime.now(),
      release: previous['release'] as String?,
      distinctId: previous['distinctId'] as String?,
      deviceOs: _facts.os,
      deviceOsVersion: _facts.osVersion,
    ));
  }

  /// Record the session's end on [collector] and clear the marker, so the
  /// next launch does not read it as a crash.
  static void _endSession(SentrinelCollector collector) {
    if (_sessionId == null || _sessionStartedAt == null) return;
    collector.recordSession(_sessionRecord(durationMs: _sessionDurationMs()));
    if (_persistCrashes) _spool?.endSession();
  }

  /// A session only gets worse, and each step is reported when it happens.
  static void _worsenSession(String status) {
    if ((_sessionRank[status] ?? 0) <= (_sessionRank[_sessionStatus] ?? 0)) return;
    _sessionStatus = status;
    if (_sessionId != null) _collector?.recordSession(_sessionRecord());
  }

  /// The app went to the background.
  ///
  /// Ends the session — with its duration — and flushes, because a
  /// backgrounded app may never get another timer tick, and the OS kills
  /// backgrounded apps without notice. Without this, every one of those kills
  /// left the marker behind and was reported as `abnormal` on the next launch:
  /// a crash-free rate dragged down by users simply switching apps.
  ///
  /// The Flutter package calls this and [onForeground] from the app lifecycle;
  /// call them yourself from plain Dart.
  static Future<void> onBackground() async {
    final collector = _collector;
    if (collector == null || collector.isDisposed) return;
    if (_backgroundedAt == null) {
      _backgroundedAt = DateTime.now();
      _endSession(collector);
    }
    await collector.flush();
  }

  /// The app came back. Within [sessionTimeout] it is the same session; past
  /// it, a new one starts.
  static void onForeground() {
    final since = _backgroundedAt;
    _backgroundedAt = null;
    final collector = _collector;
    final spool = _spool;
    if (since == null || collector == null || collector.isDisposed || spool == null) return;

    if (DateTime.now().difference(since) >= sessionTimeout) {
      _openSession(collector, spool);
    } else if (_persistCrashes && _sessionId != null) {
      // Same session: put the marker back, so a crash from here on is still
      // noticed by the next launch.
      spool.resumeSession(_sessionMarker());
    }
  }

  /// Send anything an earlier run queued to disk before it died — now, not on
  /// the first timer tick thirty seconds from now, which a short launch may
  /// never reach.
  static void _deliverPending(SentrinelCollector collector, CrashSpool spool) {
    final pending = spool.drain();
    if (pending.isEmpty) return;
    for (final record in pending) {
      // Replayed as-is: these were serialised at crash time and their
      // timestamps are from then, not now. The id is what removes the disk
      // copy once the server has it.
      collector.recordRaw(record.kind, record.json, spoolId: record.id);
    }
    unawaited(collector.flush());
  }

  /// Errors thrown on other isolates never reach a zone handler on this one.
  ///
  /// Returns without installing anything on web, which has no isolate error
  /// channel — see `isolate_hook_web.dart`.
  static void _listenForIsolateErrors() {
    _isolateErrors?.close();
    _isolateErrors = listenForIsolateErrors((error, stack) {
      // A worker isolate that dies takes its work with it, not the app.
      captureError(error, stack, handled: false, mechanism: 'Isolate.onError');
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
      // An error that reaches the zone ends the operation that threw it, not
      // the app: the zone caught it. Reported unhandled, sent soon.
      captureError(error, stack, handled: false, mechanism: 'runZonedGuarded');
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
  /// [fatal] means the process is about to die — call it that way from the
  /// last code that runs before you exit or rethrow into the platform. A fatal
  /// error is written to disk **synchronously, before this returns**, and the
  /// session is marked `crashed`; it is also sent straight away, and its disk
  /// copy is removed once the server has it, so it is never delivered twice.
  ///
  /// [handled] is false for errors nothing in the app caught — the framework,
  /// zone and isolate handlers pass it. They mark the session `errored`, not
  /// `crashed`: a Flutter app keeps running after a build error or an
  /// unawaited future's exception, and counting those as crashes made the
  /// crash-free rate meaningless. They are sent within about a second.
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
    bool handled = true,
    String? mechanism,
  }) {
    final collector = _collector;
    if (collector == null || collector.isDisposed) return;

    final record = ErrorRecord(
      method: 'APP',
      path: path ?? (fatal ? 'app/crash' : 'app'),
      statusCode: 500,
      timestamp: DateTime.now(),
      errorType: error.runtimeType.toString(),
      errorMessage: error.toString(),
      stackTrace: stack?.toString(),
      consumerIdentifier: consumer,
      attributes: {
        ..._deviceAttributes,
        ..._context,
        ...?attributes,
        if (mechanism != null) 'sentrinel.mechanism': mechanism,
        'sentrinel.handled': handled,
        if (fatal) 'sentrinel.fatal': true,
        if (_sessionId != null) 'session.id': _sessionId,
        if (_crumbs.length > 0) 'breadcrumbs': _crumbs.toJson(),
      },
    );

    // The app's filter runs before anything is written, so what it removes is
    // never on disk either.
    final json = collector.applyBeforeSend('error', record.toJson());
    if (json == null) return;

    if (fatal) {
      String? spoolId;
      final spool = _persistCrashes ? _spool : null;
      if (spool != null && spool.durable) {
        // On disk first. If the app dies on the next line the report still
        // ships on the next launch. Deduped by fingerprint: a dying process
        // that reports the same error from two handlers writes it once.
        spoolId = spool.append(
          'error',
          json,
          fingerprint: _fingerprint(error, stack),
          fsync: true,
        );
        // And mark the session, so the next launch reports `crashed` rather
        // than the vaguer `abnormal`.
        spool.markSessionCrashed();
      }
      _worsenSession('crashed');
      // Also sent now. Where there is no disk (web, persistCrashes off) this is
      // the only copy; where there is, a 2xx removes the disk one.
      collector.recordErrorJson(json, spoolId: spoolId);
      unawaited(collector.flush());
      return;
    }

    collector.recordErrorJson(json);
    _worsenSession('errored');
    if (!handled) collector.flushSoon();
  }

  static String _fingerprint(Object error, StackTrace? stack) {
    final message = error.toString().split('\n').first;
    final frames = (stack?.toString() ?? '').split('\n').take(4).join('|');
    final fp = '${error.runtimeType}|$message|$frames';
    return fp.length > 500 ? fp.substring(0, 500) : fp;
  }

  /// Hand a Flutter framework error to Sentrinel.
  ///
  /// Flutter catches errors inside its own build/layout/paint phases before any
  /// zone sees them, so [guard] alone does not cover them. Wiring is two lines,
  /// and stays in your app because the types live in `package:flutter` and
  /// `dart:ui` — dependencies this package does not take, so that it keeps
  /// working in plain Dart. (The `sentrinel_flutter` package does it for you.)
  ///
  /// ```dart
  /// FlutterError.onError = (details) => Sentrinel.flutterErrorHandler(
  ///     details.exception, details.stack,
  ///     silent: details.silent, library: details.library);
  ///
  /// PlatformDispatcher.instance.onError = (error, stack) {
  ///   Sentrinel.platformErrorHandler(error, stack);
  ///   return true;
  /// };
  /// ```
  ///
  /// Reported as unhandled, not fatal: an overflow, a failed image load or a
  /// throwing build method shows an error widget and the app carries on.
  /// [silent] errors — the ones Flutter itself declines to report in release —
  /// are skipped.
  static void flutterErrorHandler(
    Object error,
    StackTrace? stack, {
    bool silent = false,
    String? library,
    String? context,
  }) {
    if (silent) return;
    captureError(
      error,
      stack,
      handled: false,
      mechanism: 'FlutterError.onError',
      attributes: {
        if (library != null) 'flutter.library': library,
        if (context != null) 'flutter.context': context,
      },
    );
  }

  /// The companion for errors that escape to the engine — see
  /// [flutterErrorHandler]. Also unhandled, not fatal: returning true from
  /// `PlatformDispatcher.onError` keeps the app alive.
  static void platformErrorHandler(Object error, StackTrace? stack) => captureError(
        error,
        stack,
        handled: false,
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
      // Every signal names its owner, so a user's log lines are findable
      // without joining through a request that may already have expired.
      consumerIdentifier: consumer,
      category: category,
      attributes: {
        if (_anonymousId != null) 'device.id': _anonymousId,
        ..._context,
        ...?attributes,
      },
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

  /// Send whatever is buffered now. The Flutter package does this when the
  /// app is backgrounded; see [onBackground].
  static Future<void> flush() async => _collector?.flush();

  /// Shut down cleanly. Safe to call twice.
  ///
  /// Clearing the session marker is what makes crash detection mean anything:
  /// without it every ordinary exit would look, on the next launch, exactly
  /// like a crash.
  static Future<void> close() async {
    final collector = _collector;
    if (collector == null) return;
    _collector = null;
    _isolateErrors?.close();
    _isolateErrors = null;

    if (!collector.isDisposed) {
      // Recorded *before* stop(), because stop() performs the final flush.
      // Queued after it, the closing session would sit in a buffer belonging
      // to a collector that is never going to send anything again.
      if (_backgroundedAt == null) _endSession(collector);
      await collector.stop();
      collector.dispose();
    }
    _spool = null;
    _sessionId = null;
    _sessionStartedAt = null;
    _backgroundedAt = null;
    _crumbs.clear();
  }

  /// Whether [url] may receive `traceparent` and the identity headers.
  static bool shouldPropagate(Uri url) {
    // A relative URL goes to wherever the app itself came from.
    if (url.host.isEmpty) return true;
    final host = url.host.toLowerCase();
    if (runningOnWeb) {
      final base = Uri.base;
      if (base.host.toLowerCase() == host &&
          base.scheme == url.scheme &&
          base.port == url.port) {
        return true;
      }
    }
    for (final target in _propagationTargets) {
      if (target is RegExp) {
        if (target.hasMatch(url.toString())) return true;
        continue;
      }
      if (target is! String) continue;
      final t = target.trim().toLowerCase();
      if (t.isEmpty) continue;
      if (t.contains('://')) {
        if (url.toString().toLowerCase().startsWith(t)) return true;
        continue;
      }
      if (t.startsWith('*.')) {
        if (host.endsWith(t.substring(1))) return true;
        continue;
      }
      if (host == t || host.endsWith('.$t')) return true;
    }
    return false;
  }

  // ── internals used by the client wrapper ──
  static SentrinelCollector? get collector => _collector;
  static Map<String, Object?> get context => _context;

  /// Attributes every request and span carries: the install, then context.
  static Map<String, Object?> get recordAttributes => {
        if (_anonymousId != null) 'device.id': _anonymousId,
        ..._context,
      };
}

/// An [http.Client] that records every request and propagates trace context.
class SentrinelHttpClient extends http.BaseClient {
  SentrinelHttpClient(this._inner);

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final collector = Sentrinel.collector;
    if (collector == null || collector.isDisposed) return _inner.send(request);

    final trace = TraceContext();
    // Only your own backends hear about the trace and the user. Sending a
    // user id to a payment provider or a maps API was never the intent.
    if (Sentrinel.shouldPropagate(request.url)) {
      // Only set if the caller has not — an app already doing its own
      // propagation should win.
      request.headers.putIfAbsent('traceparent', () => trace.traceparent);
      final consumer = Sentrinel.consumer;
      if (consumer != null) {
        request.headers.putIfAbsent('x-sentrinel-consumer', () => consumer);
      }
      final device = Sentrinel.deviceId;
      if (device != null) request.headers.putIfAbsent('x-sentrinel-device', () => device);
    }

    final id = generateTraceId();
    final started = DateTime.now();
    final watch = Stopwatch()..start();
    final path = request.url.path.isEmpty ? '/' : request.url.path;
    final route = normaliseRoutePath(path);
    final host = request.url.host.isEmpty ? null : request.url.host;
    final attributes = Sentrinel.recordAttributes;

    try {
      final response = await _inner.send(request);
      watch.stop();
      final ms = watch.elapsedMicroseconds / 1000.0;

      collector.recordRequest(RequestRecord(
        id: id,
        method: request.method,
        path: path,
        route: route,
        host: host,
        statusCode: response.statusCode,
        responseTime: ms,
        timestamp: started,
        requestSize: request.contentLength ?? 0,
        responseSize: response.contentLength ?? 0,
        consumerIdentifier: Sentrinel.consumer,
        traceId: trace.traceId,
        attributes: attributes,
      ));

      // The client half of the waterfall. Its id is the one that went out on
      // `traceparent`, so the server's span names it as parent and the two
      // halves render as one tree. The difference between this duration and
      // the server's is the network.
      collector.recordSpan(SpanRecord(
        id: trace.spanId,
        traceId: trace.traceId,
        name: '${request.method} $route',
        startTime: started,
        durationMs: ms,
        statusCode: response.statusCode >= 500 ? 'ERROR' : 'OK',
        attributes: {
          'http.method': request.method,
          // No query, fragment or userinfo: that is where tokens live.
          'http.url': sanitizeUrl(request.url),
          'http.route': route,
          'http.status_code': response.statusCode,
          if (Sentrinel.consumer != null) 'sentrinel.consumer': Sentrinel.consumer,
          ...attributes,
        },
      ));

      // Left automatically, because a breadcrumb trail you have to remember to
      // fill is empty in exactly the app that just crashed.
      Sentrinel.addBreadcrumb(
        '${request.method} $path',
        category: 'http',
        data: {'status': response.statusCode, 'ms': ms.round()},
      );

      if (response.statusCode >= 400) {
        collector.recordError(ErrorRecord(
          method: request.method,
          // The route, not the raw path: the server groups errors by
          // endpoint, and the endpoint is the route.
          path: route,
          statusCode: response.statusCode,
          timestamp: started,
          consumerIdentifier: Sentrinel.consumer,
          requestLogId: id,
          traceId: trace.traceId,
          attributes: {...attributes, 'url.path': path, if (host != null) 'http.host': host},
        ));
      }
      return response;
    } catch (err, stack) {
      watch.stop();
      // `ClientException.toString()` carries the full URL, query and all.
      final message = scrubUrls(err.toString());
      // A transport failure never reached a server, so there is no status. 0
      // says "did not complete" rather than inventing a 5xx the server never
      // sent.
      collector.recordRequest(RequestRecord(
        id: id,
        method: request.method,
        path: path,
        route: route,
        host: host,
        statusCode: 0,
        responseTime: watch.elapsedMicroseconds / 1000.0,
        timestamp: started,
        consumerIdentifier: Sentrinel.consumer,
        errorMessage: message,
        traceId: trace.traceId,
        attributes: attributes,
      ));
      Sentrinel.addBreadcrumb(
        '${request.method} $path failed',
        category: 'http',
        data: {'error': err.runtimeType.toString()},
      );
      collector.recordError(ErrorRecord(
        method: request.method,
        path: route,
        statusCode: 0,
        timestamp: started,
        errorType: err.runtimeType.toString(),
        errorMessage: message,
        stackTrace: stack.toString(),
        consumerIdentifier: Sentrinel.consumer,
        requestLogId: id,
        traceId: trace.traceId,
        attributes: {...attributes, 'url.path': path, if (host != null) 'http.host': host},
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
