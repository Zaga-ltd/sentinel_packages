// Crash reporting is only real if the report outlives the crash.
//
// Everything else in this SDK buffers in memory and flushes on a timer. For a
// crash that is useless: the process is gone long before the next tick. So
// these tests care about one property above all — after a fatal error, is the
// report on disk, and does the next launch send it?

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel/sentrinel.dart';
import 'package:sentrinel/src/spool.dart';
import 'package:test/test.dart';

/// Captures what the SDK POSTed, keyed by ingest path.
class Captured {
  final Map<String, List<Map<String, dynamic>>> byPath = {};

  http.Client client({int status = 200}) => MockClient((req) async {
        byPath
            .putIfAbsent(req.url.path, () => [])
            .add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response('{"success":true}', status);
      });

  List<Map<String, dynamic>> rows(String path, String key) => byPath[path]
          ?.expand((b) => (b[key] as List).cast<Map<String, dynamic>>())
          .toList() ??
      [];
}

void main() {
  late Directory storage;
  late Captured captured;

  setUp(() {
    storage = Directory.systemTemp.createTempSync('sentrinel_crash_test');
    captured = Captured();
    Sentrinel.clearContext();
  });

  tearDown(() async {
    await Sentrinel.close();
    if (storage.existsSync()) storage.deleteSync(recursive: true);
  });

  void init({http.Client? client, bool persist = true}) {
    Sentrinel.init(
      serverUrl: 'https://api.test',
      appName: 'mobile-app',
      env: 'prod',
      apiKey: 'k',
      storagePath: storage.path,
      persistCrashes: persist,
      httpClient: client ?? captured.client(),
    );
  }

  group('a crash survives the process', () {
    test('a fatal error is on disk before the call returns', () {
      init();

      Sentrinel.captureError(StateError('boom'), StackTrace.current, fatal: true);

      // Not "after a flush" — immediately. This is the whole point: the app may
      // never reach another line.
      final pending = File('${storage.path}/pending.ndjson');
      expect(pending.existsSync(), isTrue);
      expect(pending.readAsStringSync(), contains('boom'));
    });

    test('a non-fatal error takes the ordinary buffered path', () async {
      init();

      Sentrinel.captureError(StateError('handled'), StackTrace.current);

      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(1));
    });

    test('the next launch sends what the crash left behind', () async {
      // Launch one: crash, then vanish without ever flushing.
      init();
      Sentrinel.captureError(ArgumentError('died here'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose();

      // Launch two: a fresh process, same storage directory.
      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: second.client(),
      );
      await Sentrinel.flush();

      final errors = second.rows('/api/ingest/errors', 'errors');
      expect(errors.any((e) => '${e['errorMessage']}'.contains('died here')), isTrue,
          reason: 'the crash report should ship on the next launch');
    });

    test('a delivered report is not sent twice', () async {
      init();
      Sentrinel.captureError(StateError('once'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose();

      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: second.client(),
      );
      await Sentrinel.flush();
      await Sentrinel.close();

      // Third launch: the queue was drained, so there is nothing left to resend.
      final third = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: third.client(),
      );
      await Sentrinel.flush();

      final repeats = third
          .rows('/api/ingest/errors', 'errors')
          .where((e) => '${e['errorMessage']}'.contains('once'));
      expect(repeats, isEmpty);
    });
  });

  group('what a crash report carries', () {
    test('the mechanism says how it was caught', () {
      init();
      Sentrinel.captureError(StateError('x'), StackTrace.current,
          fatal: true, mechanism: 'FlutterError.onError');

      final line = File('${storage.path}/pending.ndjson').readAsStringSync();
      final json = jsonDecode(line.trim()) as Map<String, dynamic>;
      final attrs = (json['record'] as Map)['attributes'] as Map;
      expect(attrs['sentrinel.mechanism'], 'FlutterError.onError');
      expect(attrs['sentrinel.fatal'], isTrue);
    });

    test('breadcrumbs explain what led to it', () {
      init();
      Sentrinel.addBreadcrumb('opened checkout', category: 'navigation');
      Sentrinel.addBreadcrumb('tapped pay', category: 'ui', data: {'amount': 42});
      Sentrinel.captureError(StateError('x'), StackTrace.current, fatal: true);

      final json = jsonDecode(
              File('${storage.path}/pending.ndjson').readAsStringSync().trim())
          as Map<String, dynamic>;
      final crumbs =
          ((json['record'] as Map)['attributes'] as Map)['breadcrumbs'] as List;
      expect(crumbs, hasLength(2));
      expect(crumbs.last['message'], 'tapped pay');
    });

    test('device facts ride along without a plugin', () {
      init();
      Sentrinel.captureError(StateError('x'), StackTrace.current, fatal: true);

      final json = jsonDecode(
              File('${storage.path}/pending.ndjson').readAsStringSync().trim())
          as Map<String, dynamic>;
      final attrs = (json['record'] as Map)['attributes'] as Map;
      expect(attrs['device.os'], isNotEmpty);
      expect(attrs['device.os_version'], isNotNull);
    });

    test('the breadcrumb trail is bounded', () {
      init();
      for (var i = 0; i < 200; i++) {
        Sentrinel.addBreadcrumb('step $i');
      }
      Sentrinel.captureError(StateError('x'), StackTrace.current, fatal: true);

      final json = jsonDecode(
              File('${storage.path}/pending.ndjson').readAsStringSync().trim())
          as Map<String, dynamic>;
      final crumbs =
          ((json['record'] as Map)['attributes'] as Map)['breadcrumbs'] as List;
      expect(crumbs.length, lessThanOrEqualTo(25));
      expect(crumbs.last['message'], 'step 199', reason: 'keeps the most recent');
    });
  });

  group('sessions', () {
    test('a clean shutdown is not reported as a crash', () async {
      init();
      await Sentrinel.close();

      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: second.client(),
      );
      expect(Sentrinel.previousRunCrashed, isFalse);
      await Sentrinel.flush();
      expect(
        second.rows('/api/ingest/errors', 'errors').where(
            (e) => e['errorType'] == 'UnfinishedSession'),
        isEmpty,
      );
    });

    test('a session that never closed is reported on the next launch', () async {
      init();
      // No close() — the marker stays behind, exactly as after a hard crash.
      Sentrinel.collector?.dispose();

      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: second.client(),
      );
      expect(Sentrinel.previousRunCrashed, isTrue);
      await Sentrinel.flush();

      // Reported as a session, not as an error: an unfinished session is a
      // denominator fact, and an error record could never produce a rate.
      final unfinished = second
          .rows('/api/ingest/sessions', 'sessions')
          .where((s) => s['status'] == 'abnormal' || s['status'] == 'crashed');
      expect(unfinished, hasLength(1));
    });
  });

  group('it cannot make things worse', () {
    test('an unusable storage directory degrades instead of throwing', () {
      final spool = CrashSpool('/proc/nonexistent/sentrinel');
      expect(() => spool.appendSync('error', {'a': 1}), returnsNormally);
      expect(spool.drain(), isEmpty);
    });

    test('a truncated trailing line does not lose the rest', () {
      final spool = CrashSpool(storage.path);
      spool.appendSync('error', {'errorMessage': 'first'});
      spool.appendSync('error', {'errorMessage': 'second'});
      // Simulate dying mid-append.
      final f = File('${storage.path}/pending.ndjson');
      f.writeAsStringSync('{"kind":"error","rec', mode: FileMode.append);

      final drained = spool.drain();
      expect(drained, hasLength(2));
      expect(drained.first.json['errorMessage'], 'first');
    });

    test('persistCrashes: false keeps everything in memory', () async {
      init(persist: false);
      Sentrinel.captureError(StateError('x'), StackTrace.current, fatal: true);

      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(1));
    });

    test('guard() reports what escapes to the zone', () async {
      init();
      Sentrinel.guard(() {
        Future<void>.error(StateError('async escape'));
      });
      // Let the microtask queue deliver the error to the zone handler.
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final pending = File('${storage.path}/pending.ndjson');
      expect(pending.existsSync(), isTrue);
      expect(pending.readAsStringSync(), contains('async escape'));
      expect(pending.readAsStringSync(), contains('runZonedGuarded'));
    });
  });

  group('release health', () {
    test('a launch reports a session, so the rate has a denominator', () async {
      init();
      await Sentrinel.flush();

      final sessions = captured.rows('/api/ingest/sessions', 'sessions');
      expect(sessions, hasLength(1));
      expect(sessions.single['status'], 'ok');
      expect(sessions.single['sessionId'], isNotEmpty);
    });

    test('a clean exit closes the session with a duration', () async {
      init();
      await Sentrinel.close();

      final ended = captured
          .rows('/api/ingest/sessions', 'sessions')
          .where((s) => s['durationMs'] != null);
      expect(ended, isNotEmpty);
      expect(ended.last['status'], 'ok');
    });

    test('a crash marks the previous session crashed, not abnormal', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        release: '1.4.2',
        httpClient: captured.client(),
      );
      Sentrinel.captureError(StateError('fatal'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose(); // process dies

      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        release: '1.4.2',
        httpClient: second.client(),
      );
      await Sentrinel.flush();

      final crashed = second
          .rows('/api/ingest/sessions', 'sessions')
          .where((s) => s['status'] == 'crashed');
      expect(crashed, hasLength(1));
      expect(crashed.single['release'], '1.4.2',
          reason: 'crash-free rate is per release, so the release must ride along');
    });

    test('a force-quit is abnormal, not a crash against the release', () async {
      init();
      // No fatal error — just gone. A user swiping the app away.
      Sentrinel.collector?.dispose();

      final second = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        env: 'prod',
        apiKey: 'k',
        storagePath: storage.path,
        httpClient: second.client(),
      );
      await Sentrinel.flush();

      final statuses = second
          .rows('/api/ingest/sessions', 'sessions')
          .map((s) => s['status'])
          .toSet();
      expect(statuses, contains('abnormal'));
      expect(statuses, isNot(contains('crashed')),
          reason: 'blaming the release for a force-quit would make the metric useless');
    });
  });
}
