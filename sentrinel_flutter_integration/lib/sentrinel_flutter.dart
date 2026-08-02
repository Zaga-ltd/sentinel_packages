/// Sentrinel for Flutter.
///
/// The pure-Dart `sentrinel` package does the collecting. This does the three
/// things that need the framework and therefore cannot live there:
///
///   * catches errors Flutter handles internally, which never reach a zone,
///   * measures app start and dropped frames,
///   * finds a storage directory that survives a restart.
///
/// ```dart
/// void main() => SentrinelFlutter.run(
///       options: SentrinelOptions(
///         serverUrl: 'https://api.sentrinel.dev',
///         appName: 'mobile-app',
///         release: '1.4.2',
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

export 'src/frames.dart' show FrameTracker, kFrozenFrameMs, kDefaultFrameBudgetMs;
export 'src/navigation.dart' show SentrinelNavigatorObserver;

/// Everything [SentrinelFlutter.run] needs. Mirrors `Sentrinel.init`, plus the
/// Flutter-only switches.
class SentrinelOptions {
  const SentrinelOptions({
    required this.serverUrl,
    required this.appName,
    this.env = 'prod',
    this.apiKey,
    this.release,
    this.consumerIdentifier,
    this.flushInterval = const Duration(seconds: 30),
    this.trackFrames = true,
    this.trackAppStart = true,
  });

  final String serverUrl;
  final String appName;
  final String env;
  final String? apiKey;

  /// The build. Crash-free rate is per release; without it every build is
  /// "unknown" and a regression is invisible.
  final String? release;

  final String? consumerIdentifier;
  final Duration flushInterval;
  final bool trackFrames;
  final bool trackAppStart;
}

class SentrinelFlutter {
  SentrinelFlutter._();

  static FrameTracker? _frames;
  static DateTime? _initAt;
  static bool _firstFrameReported = false;

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
  /// calling it inside one — see [Sentrinel.guard].
  static Future<void> init(SentrinelOptions options) async {
    _initAt = DateTime.now();
    _firstFrameReported = false;

    Sentrinel.init(
      serverUrl: options.serverUrl,
      appName: options.appName,
      env: options.env,
      apiKey: options.apiKey,
      release: options.release,
      consumerIdentifier: options.consumerIdentifier,
      flushInterval: options.flushInterval,
      storagePath: await _storagePath(),
    );

    installErrorHandlers();
    if (options.trackFrames) {
      _frames = FrameTracker()..start();
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
      // Unavailable in a plain test binding, or on a platform without the
      // plugin. The core falls back to temp, which still works.
      return null;
    }
  }

  /// Catch the errors a zone never sees.
  ///
  /// Flutter handles framework errors itself — build, layout and paint failures
  /// go to [FlutterError.onError] and stop there. Errors that escape to the
  /// engine go to [PlatformDispatcher.onError]. Neither reaches
  /// `runZonedGuarded`, so without these two the majority of real Flutter
  /// crashes would go unreported while everything looked wired up.
  static void installErrorHandlers() {
    final priorFlutter = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      Sentrinel.flutterErrorHandler(details.exception, details.stack);
      // Chained, not replaced: red screens in debug and whatever else the app
      // had installed must keep working.
      priorFlutter?.call(details);
    };

    final priorPlatform = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      Sentrinel.platformErrorHandler(error, stack);
      return priorPlatform?.call(error, stack) ?? true;
    };
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

  /// Flush on backgrounding.
  ///
  /// A backgrounded app may never get another timer tick, and on iOS may be
  /// terminated without further notice. Attach it to your lifecycle handling:
  ///
  /// ```dart
  /// AppLifecycleListener(onPause: SentrinelFlutter.onPause)
  /// ```
  static Future<void> onPause() async {
    _frames?.flushWindow();
    await Sentrinel.flush();
  }

  /// Stop tracking and shut the core down cleanly, closing the session.
  static Future<void> close() async {
    _frames?.stop();
    _frames = null;
    await Sentrinel.close();
  }
}
