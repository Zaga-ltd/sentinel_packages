// The Flutter half: the errors a zone never sees, frames, and navigation.
//
// These run against a real widget binding, because that is the only place the
// behaviour exists — FlutterError.onError and the frame timing callbacks do not
// fire in a plain Dart test, so asserting on them anywhere else would prove
// nothing.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' show FrameTiming, PlatformDispatcher;

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
    test('a framework error is reported as a crash', () {
      final prior = FlutterError.onError;
      SentrinelFlutter.installErrorHandlers();

      FlutterError.onError!(FlutterErrorDetails(
        exception: StateError('build blew up'),
        stack: StackTrace.current,
        library: 'widgets library',
      ));

      // On disk immediately — a framework error can be the last thing that
      // happens before the app is gone.
      final pending = File('${storage.path}/pending.ndjson').readAsStringSync();
      expect(pending, contains('build blew up'));
      expect(pending, contains('FlutterError.onError'));

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

    test('an engine error is reported and still handled', () {
      final prior = PlatformDispatcher.instance.onError;
      SentrinelFlutter.installErrorHandlers();

      final handled = PlatformDispatcher.instance.onError!(
        ArgumentError('escaped to the engine'),
        StackTrace.current,
      );

      expect(handled, isTrue, reason: 'returning false would crash the app');
      expect(
        File('${storage.path}/pending.ndjson').readAsStringSync(),
        contains('escaped to the engine'),
      );
      PlatformDispatcher.instance.onError = prior;
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
    testWidgets('a route change leaves a breadcrumb and sets the screen',
        (tester) async {
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

    testWidgets('popping reports the route underneath, not the one that left',
        (tester) async {
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

      expect(observer.currentRoute, '/',
          reason: 'after a pop the user is on the route underneath');
    });
  });
}

/// A FrameTiming with a known total span.
FrameTiming _timing(int totalMs) {
  const start = 0;
  final end = totalMs * 1000; // microseconds
  return FrameTiming(
    vsyncStart: start,
    buildStart: start,
    buildFinish: end ~/ 2,
    rasterStart: end ~/ 2,
    rasterFinish: end,
    rasterFinishWallTime: end,
  );
}
