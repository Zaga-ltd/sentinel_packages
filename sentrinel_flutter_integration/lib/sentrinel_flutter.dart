/// Sentrinel for Flutter.
///
/// The pure-Dart `sentrinel` package does the collecting. This does the things
/// that need the framework and therefore cannot live there:
///
///   * catches errors Flutter handles internally, which never reach a zone,
///   * measures app start and dropped frames,
///   * ends the session when the app is backgrounded and flushes,
///   * tells the core whether this is a phone or a tablet,
///   * finds a storage directory that survives a restart.
///
/// ```dart
/// void main() => SentrinelFlutter.run(
///       options: SentrinelOptions(
///         serverUrl: 'https://api.sentrinel.dev',
///         appName: 'mobile-app',
///         release: '1.4.2',
///         tracePropagationTargets: ['api.example.com'],
///       ),
///       app: () => runApp(const MyApp()),
///     );
/// ```
///
/// That single call replaces the boilerplate the core package documents. If you
/// would rather wire it yourself, everything here is available piecemeal.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sentrinel/sentrinel.dart';

import 'src/frames.dart';

// The core, re-exported.
//
// Splitting into two packages is an implementation detail of *our* build, not
// something a Flutter app should have to know about: importing this and then
// finding `Sentrinel`, `TraceContext` and the record types undefined is a
// papercut with no upside. One import gets everything.
export 'package:sentrinel/sentrinel.dart';

export 'src/frames.dart'
    show FrameTracker, kFrozenFrameMs, kDefaultFrameBudgetMs, displayFrameBudgetMs;
export 'src/navigation.dart' show SentrinelNavigatorObserver;

/// Everything [SentrinelFlutter.run] needs. Mirrors `Sentrinel.init`, plus the
/// Flutter-only switches.
class SentrinelOptions {
  const SentrinelOptions({
    required this.serverUrl,
    required this.appName,
    this.env = 'prod',
    this.apiKey,
    this.module,
    this.release,
    this.consumerIdentifier,
    this.flushInterval = const Duration(seconds: 30),
    this.trackFrames = true,
    this.trackAppStart = true,
    this.trackLifecycle = true,
    this.tracePropagationTargets = const [],
    this.beforeSend,
    this.persistCrashes = true,
    this.storagePath,
    this.httpClient,
  });

  final String serverUrl;
  final String appName;
  final String env;
  final String? apiKey;

  /// Which part of the project this app is. See `Sentrinel.init`.
  final String? module;

  /// The build. Crash-free rate is per release; without it every build is
  /// "unknown" and a regression is invisible.
  final String? release;

  /// Pins the consumer to a fixed value. Usually leave it out and call
  /// `Sentrinel.identify(user.id)` after sign-in — see `Sentrinel.init`.
  final String? consumerIdentifier;
  final Duration flushInterval;
  final bool trackFrames;
  final bool trackAppStart;

  /// End the session and flush when the app goes to the background; resume
  /// or start a new one when it returns. Off only if you call
  /// `Sentrinel.onBackground` / `onForeground` yourself.
  final bool trackLifecycle;

  /// Your own backends — they receive `traceparent` and the consumer/device
  /// headers. See `Sentrinel.init`.
  final List<Object> tracePropagationTargets;

  /// Rewrite or drop records before they are sent or stored.
  final BeforeSend? beforeSend;

  /// See `Sentrinel.init`.
  final bool persistCrashes;

  /// Where crash reports and the install id live. Null — the default — uses
  /// `<application support>/sentrinel` from path_provider.
  final String? storagePath;

  /// Used for telemetry posts; never closed by Sentrinel. Null uses a plain
  /// client.
  final http.Client? httpClient;
}

class SentrinelFlutter {
  SentrinelFlutter._();

  static FrameTracker? _frames;
  static DateTime? _initAt;
  static bool _firstFrameReported = false;
  static _LifecycleObserver? _lifecycle;

  /// The handlers this package installed, so a second call can tell its own
  /// handler from one the app installed on top — and not wrap itself again.
  static FlutterExceptionHandler? _flutterHandler;
  static bool Function(Object, StackTrace)? _platformHandler;

  /// Frame statistics for the current window, or null when not tracking.
  static FrameTracker? get frames => _frames;

  /// Initialise, wire every handler, and run the app inside a guarded zone.
  ///
  /// The zone matters: `runApp` must be called inside it, or asynchronous
  /// errors escape to the default handler and are never reported. That is why
  /// this takes a callback rather than letting you call `runApp` afterwards.
  static Future<void> run({
    required SentrinelOptions options,
    required FutureOr<void> Function() app,
  }) async {
    await Sentrinel.guard(() async {
      // Needed before path_provider, and before any binding-dependent call.
      WidgetsFlutterBinding.ensureInitialized();
      await init(options);
      await app();
    });
  }

  /// Initialise without taking over `runApp`.
  ///
  /// Use this if you already have your own zone. You are then responsible for
  /// calling it inside one — see [Sentrinel.guard]. Calling it again replaces
  /// the configuration; handlers, the frame tracker and the lifecycle observer
  /// are installed once, not stacked.
  static Future<void> init(SentrinelOptions options) async {
    _initAt = DateTime.now();
    _firstFrameReported = false;

    Sentrinel.init(
      serverUrl: options.serverUrl,
      appName: options.appName,
      env: options.env,
      apiKey: options.apiKey,
      module: options.module,
      release: options.release,
      consumerIdentifier: options.consumerIdentifier,
      flushInterval: options.flushInterval,
      storagePath: options.storagePath ?? await _storagePath(),
      httpClient: options.httpClient,
      tracePropagationTargets: options.tracePropagationTargets,
      beforeSend: options.beforeSend,
      persistCrashes: options.persistCrashes,
    );

    _reportDeviceType();
    installErrorHandlers();

    _frames?.stop();
    _frames = options.trackFrames ? (FrameTracker()..start()) : null;

    if (options.trackLifecycle && _lifecycle == null) {
      _lifecycle = _LifecycleObserver();
      WidgetsBinding.instance.addObserver(_lifecycle!);
    } else if (!options.trackLifecycle && _lifecycle != null) {
      WidgetsBinding.instance.removeObserver(_lifecycle!);
      _lifecycle = null;
    }

    if (options.trackAppStart) _reportFirstFrame();
  }

  /// A directory the OS will not clear between launches.
  ///
  /// The core package falls back to the system temp directory, which is fair
  /// game for cleanup — a crash report is worth nothing if it is deleted before
  /// the next launch. Application support is the right place on both platforms.
  static Future<String?> _storagePath() async {
    try {
      final dir = await getApplicationSupportDirectory();
      return '${dir.path}/sentrinel';
    } catch (_) {
      // Unavailable in a plain test binding, on web, or on a platform without
      // the plugin. The core falls back to temp, which still works.
      return null;
    }
  }

  /// Phone or tablet, from the screen: the same 600dp line Material uses.
  ///
  /// `dart:io` knows the OS but not the form factor, and without this every
  /// iPad was reported as a phone.
  static void _reportDeviceType() {
    if (kIsWeb) return; // the browser's own User-Agent already says it
    final platform = defaultTargetPlatform;
    if (platform != TargetPlatform.android && platform != TargetPlatform.iOS) return;
    try {
      final views = WidgetsBinding.instance.platformDispatcher.views;
      if (views.isEmpty) return;
      final view = views.first;
      if (view.devicePixelRatio <= 0) return;
      final size = view.physicalSize / view.devicePixelRatio;
      if (size.isEmpty) return;
      Sentrinel.setDeviceInfo(deviceType: size.shortestSide >= 600 ? 'tablet' : 'mobile');
    } catch (_) {
      // No view yet (a headless engine): the core's "mobile" default stands.
    }
  }

  /// Catch the errors a zone never sees.
  ///
  /// Flutter handles framework errors itself — build, layout and paint failures
  /// go to [FlutterError.onError] and stop there. Errors that escape to the
  /// engine go to [PlatformDispatcher.onError]. Neither reaches
  /// `runZonedGuarded`, so without these two most real Flutter errors would go
  /// unreported while everything looked wired up.
  ///
  /// Both are reported as unhandled, not as crashes: after an overflow, a
  /// failed image or a throwing build method Flutter shows an error widget and
  /// the app carries on. Errors Flutter marks `silent` are not reported.
  ///
  /// Safe to call more than once: a handler this package already installed is
  /// not wrapped a second time, which would report every error twice.
  static void installErrorHandlers() {
    final currentFlutter = FlutterError.onError;
    if (currentFlutter == null || !identical(currentFlutter, _flutterHandler)) {
      final prior = currentFlutter;
      void handler(FlutterErrorDetails details) {
        Sentrinel.flutterErrorHandler(
          details.exception,
          details.stack,
          silent: details.silent,
          library: details.library,
          context: details.context?.toString(),
        );
        // Chained, not replaced: red screens in debug and whatever else the
        // app had installed must keep working.
        prior?.call(details);
      }

      _flutterHandler = handler;
      FlutterError.onError = handler;
    }

    final dispatcher = PlatformDispatcher.instance;
    final currentPlatform = dispatcher.onError;
    if (currentPlatform == null || !identical(currentPlatform, _platformHandler)) {
      final prior = currentPlatform;
      bool handler(Object error, StackTrace stack) {
        Sentrinel.platformErrorHandler(error, stack);
        return prior?.call(error, stack) ?? true;
      }

      _platformHandler = handler;
      dispatcher.onError = handler;
    }
  }

  /// Time to the first rendered frame.
  ///
  /// Measured from [init], so it is the Dart-side start: it does not include
  /// engine boot or process spawn, and is deliberately not called "cold start".
  /// Reporting a number that excludes half of what the user waited for, under a
  /// name implying it does not, would be worse than not measuring at all.
  static void _reportFirstFrame() {
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (_firstFrameReported || _initAt == null) return;
      _firstFrameReported = true;
      final ms = DateTime.now().difference(_initAt!).inMilliseconds;
      Sentrinel.log('info', 'app start', category: 'performance', attributes: {
        'app.start_to_first_frame_ms': ms,
        'app.start_measured_from': 'sentrinel_init',
      });
      Sentrinel.addBreadcrumb('first frame in ${ms}ms', category: 'lifecycle');
    });
  }

  /// Report the frame window, end the session and flush — what the lifecycle
  /// observer does when the app is backgrounded. Public for apps that turned
  /// `trackLifecycle` off and drive it themselves.
  static Future<void> onPause() async {
    _frames?.flushWindow();
    await Sentrinel.onBackground();
  }

  /// The counterpart of [onPause].
  static void onResume() => Sentrinel.onForeground();

  /// Stop tracking and shut the core down cleanly, closing the session.
  static Future<void> close() async {
    _frames?.stop();
    _frames = null;
    final lifecycle = _lifecycle;
    if (lifecycle != null) {
      WidgetsBinding.instance.removeObserver(lifecycle);
      _lifecycle = null;
    }
    await Sentrinel.close();
  }
}

/// Ends the session when the app leaves the foreground, and resumes it when
/// it returns.
///
/// A `WidgetsBindingObserver` rather than `AppLifecycleListener`, which needs
/// Flutter 3.13 — this package supports 3.10. `hidden` arrived in 3.13 too, so
/// it is matched by name.
class _LifecycleObserver extends WidgetsBindingObserver {
  bool _away = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (_away) {
        _away = false;
        SentrinelFlutter.onResume();
      }
      return;
    }
    // `inactive` is a phone call or the app switcher opening: often
    // momentary, and the app may still be visible. Everything past it means
    // the app is no longer on screen and may be killed without notice.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached ||
        state.name == 'hidden') {
      if (_away) return;
      _away = true;
      unawaited(SentrinelFlutter.onPause());
    }
  }
}
