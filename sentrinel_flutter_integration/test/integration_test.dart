// The Flutter half: the errors a zone never sees, the app lifecycle, frames,
// the device, and navigation.
//
// These run against a real widget binding, because that is the only place the
// behaviour exists — FlutterError.onError and the frame timing callbacks do not
// fire in a plain Dart test, so asserting on them anywhere else would prove
// nothing.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' show FrameTiming, PlatformDispatcher, Size;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel_flutter/sentrinel_flutter.dart';

class Captured {
  final Map<String, List<Map<String, dynamic>>> byPath = {};

  http.Client client() => MockClient((req) async {
        byPath
            .putIfAbsent(req.url.path, () => [])
            .add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response('{"success":true}', 200);
      });

  List<Map<String, dynamic>> rows(String path, String key) => byPath[path]
          ?.expand((b) => (b[key] as List).cast<Map<String, dynamic>>())
          .toList() ??
      [];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory storage;
  late Captured captured;

  setUp(() {
    storage = Directory.systemTemp.createTempSync('sentrinel_flutter_test');
    captured = Captured();
    Sentrinel.clearContext();
    Sentrinel.init(
      serverUrl: 'https://api.test',
      appName: 'mobile-app',
      env: 'prod',
      apiKey: 'k',
      release: '2.0.0',
      storagePath: storage.path,
      httpClient: captured.client(),
    );
  });

  tearDown(() async {
    await Sentrinel.close();
    if (storage.existsSync()) storage.deleteSync(recursive: true);
  });

  group('errors a zone never sees', () {
    test('a framework error is reported unhandled, not as a crash', () async {
      final prior = FlutterError.onError;
      SentrinelFlutter.installErrorHandlers();

      FlutterError.onError!(FlutterErrorDetails(
        exception: StateError('build blew up'),
        stack: StackTrace.current,
        library: 'widgets library',
      ));
      await Sentrinel.flush();

      final error = captured.rows('/api/ingest/errors', 'errors').single;
      expect(error['errorMessage'], contains('build blew up'));
      expect(error['attributes']['sentrinel.mechanism'], 'FlutterError.onError');
      expect(error['attributes']['sentrinel.handled'], isFalse);
      expect(error['attributes']['flutter.library'], 'widgets library');
      expect((error['attributes'] as Map).containsKey('sentrinel.fatal'), isFalse);
      // An overflow or a failed image leaves the app running. Held on disk and
      // counted as a crash, it made the crash-free rate meaningless.
      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
      final statuses = captured.rows('/api/ingest/sessions', 'sessions').map((s) => s['status']);
      expect(statuses, contains('errored'));
      expect(statuses, isNot(contains('crashed')));

      FlutterError.onError = prior;
    });

    test('a silent error is not reported', () async {
      final prior = FlutterError.onError;
      SentrinelFlutter.installErrorHandlers();
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('benign'), silent: true));
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors'), isEmpty);
      FlutterError.onError = prior;
    });

    test('the handler already installed still runs', () {
      final prior = FlutterError.onError;
      var priorCalled = false;
      FlutterError.onError = (_) => priorCalled = true;

      SentrinelFlutter.installErrorHandlers();
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('x')));

      // Replacing rather than chaining would silence the red screen in debug,
      // and anything else the app had wired up.
      expect(priorCalled, isTrue);
      FlutterError.onError = prior;
    });

    test('installing twice does not report every error twice', () async {
      final prior = FlutterError.onError;
      final priorPlatform = PlatformDispatcher.instance.onError;
      FlutterError.onError = (_) {};
      SentrinelFlutter.installErrorHandlers();
      SentrinelFlutter.installErrorHandlers();

      FlutterError.onError!(FlutterErrorDetails(exception: StateError('once')));
      PlatformDispatcher.instance.onError!(ArgumentError('once too'), StackTrace.current);
      await Sentrinel.flush();

      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(2));
      FlutterError.onError = prior;
      PlatformDispatcher.instance.onError = priorPlatform;
    });

    test('an engine error is reported and still handled', () async {
      final prior = PlatformDispatcher.instance.onError;
      SentrinelFlutter.installErrorHandlers();

      final handled = PlatformDispatcher.instance.onError!(
        ArgumentError('escaped to the engine'),
        StackTrace.current,
      );
      await Sentrinel.flush();

      expect(handled, isTrue, reason: 'returning false would crash the app');
      final error = captured.rows('/api/ingest/errors', 'errors').single;
      expect(error['errorMessage'], contains('escaped to the engine'));
      expect(error['attributes']['sentrinel.mechanism'], 'PlatformDispatcher.onError');
      PlatformDispatcher.instance.onError = prior;
    });
  });

  group('the app lifecycle', () {
    // A backgrounded app may be killed by the OS without another line of Dart
    // running. Before this, nothing flushed on backgrounding unless the app
    // wired it up, and every such kill left the session marker behind — so the
    // next launch reported an `abnormal` session for a user who merely
    // switched apps.
    Future<void> initFlutter() => SentrinelFlutter.init(SentrinelOptions(
          serverUrl: 'https://api.test',
          appName: 'mobile-app',
          apiKey: 'k',
          release: '2.0.0',
          storagePath: storage.path,
          httpClient: captured.client(),
          trackFrames: false,
          trackAppStart: false,
        ));

    tearDown(SentrinelFlutter.close);

    test('backgrounding flushes and ends the session with its duration', () async {
      await initFlutter();
      Sentrinel.info('before background');

      final binding = WidgetsBinding.instance;
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(captured.rows('/api/ingest/logs', 'logs').map((l) => l['message']),
          contains('before background'));
      final ended =
          captured.rows('/api/ingest/sessions', 'sessions').where((s) => s['durationMs'] != null);
      expect(ended, isNotEmpty);
      expect(ended.last['status'], 'ok');
      expect(File('${storage.path}/session.json').existsSync(), isFalse,
          reason: 'an OS kill from here is not an abnormal exit');

      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(File('${storage.path}/session.json').existsSync(), isTrue,
          reason: 'back in the foreground, a crash must be noticed again');
    });

    test('initialising twice installs one observer and one set of handlers', () async {
      final prior = FlutterError.onError;
      FlutterError.onError = (_) {};
      await initFlutter();
      await initFlutter();
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('after two inits')));
      await Sentrinel.flush();
      expect(
        captured
            .rows('/api/ingest/errors', 'errors')
            .where((e) => '${e['errorMessage']}'.contains('after two inits')),
        hasLength(1),
      );
      FlutterError.onError = prior;
    });
  });

  group('the device', () {
    TestFlutterView view() =>
        WidgetsBinding.instance.platformDispatcher.views.first as TestFlutterView;

    tearDown(() {
      debugDefaultTargetPlatformOverride = null;
      view().resetPhysicalSize();
      view().resetDevicePixelRatio();
    });

    Future<Map<String, dynamic>> eventsEnvelope() async {
      await SentrinelFlutter.init(SentrinelOptions(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        storagePath: storage.path,
        httpClient: captured.client(),
        trackFrames: false,
        trackAppStart: false,
        trackLifecycle: false,
      ));
      Sentrinel.track('opened');
      await Sentrinel.flush();
      await SentrinelFlutter.close();
      return captured.byPath['/api/ingest/events']!.last;
    }

    test('a phone-sized screen is a phone', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      view().physicalSize = const Size(1080, 2400);
      view().devicePixelRatio = 3;
      expect((await eventsEnvelope())['deviceType'], 'mobile');
    });

    test('a tablet-sized screen is a tablet', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      view().physicalSize = const Size(2048, 2732);
      view().devicePixelRatio = 2;
      expect((await eventsEnvelope())['deviceType'], 'tablet');
      // Overrides outlive an init; leave the default behind for later tests.
      Sentrinel.setDeviceInfo(deviceType: 'mobile');
    });
  });

  group('frames', () {
    test('slow and frozen are counted apart', () {
      final tracker = FrameTracker(budgetMs: 16);
      // Fed directly: waiting for real frames would make this a timing test.
      final timings = [
        _timing(8), // fine
        _timing(30), // slow
        _timing(900), // frozen — the app visibly stopped
      ];
      for (final t in timings) {
        // ignore: invalid_use_of_visible_for_testing_member
        tracker.consumeForTest(t);
      }

      expect(tracker.totalFrames, 3);
      expect(tracker.slowFrames, 1);
      expect(tracker.frozenFrames, 1, reason: 'a 900ms frame is not merely slow');
    });

    test('the budget is the display\'s, so 120Hz is judged at 8ms', () {
      // At 120Hz a 12ms frame missed a vsync — a visible stutter on that
      // screen, even though it would have met a 60Hz budget.
      final tracker = FrameTracker(budgetMs: 1000 / 120);
      // ignore: invalid_use_of_visible_for_testing_member
      tracker.consumeForTest(_timingUs(12000));
      expect(tracker.slowFrames, 1);

      // Unset, it comes from the display the binding reports.
      expect(FrameTracker().budgetMs, closeTo(displayFrameBudgetMs() ?? 16, 0.01));
    });

    test('a window is reported as one summary, not one record per frame', () async {
      final tracker = FrameTracker(budgetMs: 16);
      for (var i = 0; i < 500; i++) {
        // ignore: invalid_use_of_visible_for_testing_member
        tracker.consumeForTest(_timing(i.isEven ? 8 : 40));
      }
      tracker.flushWindow();
      await Sentrinel.flush();

      final logs = captured.rows('/api/ingest/logs', 'logs');
      final frame = logs.where((l) => l['message'] == 'frame timings');
      expect(frame, hasLength(1), reason: '500 frames must not become 500 records');
      expect(frame.single['attributes']['frames.total'], 500);
      expect(frame.single['attributes']['frames.slow'], 250);
    });
  });

  group('navigation', () {
    testWidgets('a route change leaves a breadcrumb and sets the screen', (tester) async {
      final observer = SentrinelNavigatorObserver();

      await tester.pumpWidget(MaterialApp(
        navigatorObservers: [observer],
        routes: {
          '/': (_) => const Scaffold(body: Text('home')),
          '/checkout': (_) => const Scaffold(body: Text('checkout')),
        },
      ));

      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      navigator.pushNamed('/checkout');
      await tester.pumpAndSettle();

      expect(observer.currentRoute, '/checkout');
      // On the context, so every later error and request carries it without the
      // app having to remember.
      expect(Sentrinel.context['screen'], '/checkout');

      Sentrinel.captureError(StateError('on checkout'), StackTrace.current, fatal: true);
      final pending = File('${storage.path}/pending.ndjson').readAsStringSync();
      expect(pending, contains('/checkout'));
      expect(pending, contains('navigation'));
    });

    testWidgets('popping reports the route underneath, not the one that left', (tester) async {
      final observer = SentrinelNavigatorObserver();
      await tester.pumpWidget(MaterialApp(
        navigatorObservers: [observer],
        routes: {
          '/': (_) => const Scaffold(body: Text('home')),
          '/checkout': (_) => const Scaffold(body: Text('checkout')),
        },
      ));

      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      navigator.pushNamed('/checkout');
      await tester.pumpAndSettle();
      navigator.pop();
      await tester.pumpAndSettle();

      expect(observer.currentRoute, '/', reason: 'after a pop the user is on the route underneath');
    });
  });
}

/// A FrameTiming with a known total span.
FrameTiming _timing(int totalMs) => _timingUs(totalMs * 1000);

FrameTiming _timingUs(int end) {
  const start = 0;
  return FrameTiming(
    vsyncStart: start,
    buildStart: start,
    buildFinish: end ~/ 2,
    rasterStart: end ~/ 2,
    rasterFinish: end,
    rasterFinishWallTime: end,
  );
}
