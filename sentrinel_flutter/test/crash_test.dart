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
      expect(attrs['device.id'], Sentrinel.deviceId);
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
      expect(File('${storage.path}/session.json').existsSync(), isFalse);
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(1));
    });

    test('guard() reports what escapes to the zone, without calling it a crash', () async {
      // An unawaited future's error ends that future, not the app. It used to
      // be written to the crash spool and held until the next launch — then
      // counted against the release as a crash that never happened.
      init();
      Sentrinel.guard(() {
        Future<void>.error(StateError('async escape'));
      });
      // The zone handler runs, then the error is sent within about a second.
      await Future<void>.delayed(const Duration(milliseconds: 1300));
      await Sentrinel.flush();

      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
      final error = captured.rows('/api/ingest/errors', 'errors').single;
      expect(error['errorMessage'], contains('async escape'));
      expect(error['attributes']['sentrinel.mechanism'], 'runZonedGuarded');
      expect(error['attributes']['sentrinel.handled'], isFalse);
      expect(error['attributes'].containsKey('sentrinel.fatal'), isFalse);

      final statuses = captured.rows('/api/ingest/sessions', 'sessions').map((s) => s['status']);
      expect(statuses, contains('errored'));
      expect(statuses, isNot(contains('crashed')));
    });

    test('a record the spool cannot encode does not close the spool', () {
      // A cycle in the attributes used to set `unusable`, so every later crash
      // of the run went unrecorded.
      init();
      final cyclic = <String, Object?>{};
      cyclic['self'] = cyclic;
      Sentrinel.captureError(StateError('first'), null, fatal: true, attributes: {'c': cyclic});
      Sentrinel.captureError(StateError('second'), StackTrace.current,
          fatal: true, attributes: {'at': DateTime.utc(2026)});

      final text = File('${storage.path}/pending.ndjson').readAsStringSync();
      expect(text, contains('second'));
      expect(text, contains('2026-01-01T00:00:00.000Z'));
    });

    test('the spool is bounded and one error is written once per run', () {
      final spool = CrashSpool(storage.path, maxRecords: 3);
      expect(spool.append('error', {'n': 1}, fingerprint: 'same'), isNotNull);
      expect(spool.append('error', {'n': 2}, fingerprint: 'same'), isNull,
          reason: 'a dying process reporting one error twice writes it once');
      expect(spool.append('error', {'n': 3}), isNotNull);
      expect(spool.append('error', {'n': 4}), isNotNull);
      expect(spool.append('error', {'n': 5}), isNull, reason: 'at the cap');
      expect(File('${storage.path}/pending.ndjson').readAsLinesSync(), hasLength(3));

      final bytes = CrashSpool('${storage.path}/b', maxBytes: 200);
      expect(bytes.append('error', {'m': 'x' * 100}), isNotNull);
      expect(bytes.append('error', {'m': 'x' * 100}), isNull);
    });
  });

  group('a crash report leaves the disk only once the server has it', () {
    test('a fatal error is sent now, and its disk copy goes after the 2xx', () async {
      init();
      Sentrinel.captureError(StateError('fatal but alive'), StackTrace.current, fatal: true);
      expect(File('${storage.path}/pending.ndjson').readAsStringSync(), contains('fatal but alive'));

      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(1));
      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse,
          reason: 'still on disk, the next launch would send it a second time');
    });

    test('a replay that fails is tried again on the next launch', () async {
      // Launch one: crash.
      init();
      Sentrinel.captureError(StateError('survives a bad network'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose();

      // Launch two: offline. The old reader had already deleted the file.
      init(client: MockClient((_) async => throw const SocketException('offline')));
      await Sentrinel.flush();
      Sentrinel.collector?.dispose();

      // Launch three: online.
      final third = Captured();
      init(client: third.client());
      await Sentrinel.flush();

      expect(
        third.rows('/api/ingest/errors', 'errors').where(
            (e) => '${e['errorMessage']}'.contains('survives a bad network')),
        hasLength(1),
      );
      expect(File('${storage.path}/inflight.ndjson').existsSync(), isFalse);
      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
    });

    test('a replay that fails is retried within the same run, too', () async {
      init();
      Sentrinel.captureError(StateError('retry me'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose();

      var up = false;
      final later = Captured();
      init(client: MockClient((req) async {
        if (!up) throw const SocketException('offline');
        later.byPath
            .putIfAbsent(req.url.path, () => [])
            .add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }));
      await Sentrinel.flush();
      up = true;
      await Sentrinel.flush();

      expect(later.rows('/api/ingest/errors', 'errors').where(
          (e) => '${e['errorMessage']}'.contains('retry me')), hasLength(1));
      expect(File('${storage.path}/inflight.ndjson').existsSync(), isFalse);
    });

    test('a record the server refuses outright is not replayed forever', () async {
      init();
      Sentrinel.captureError(StateError('malformed'), StackTrace.current, fatal: true);
      Sentrinel.collector?.dispose();

      init(client: MockClient((_) async => http.Response('{"error":"bad"}', 400)));
      await Sentrinel.flush();
      expect(File('${storage.path}/inflight.ndjson').existsSync(), isFalse);
    });

    test('an older SDK\'s spool, without ids, still replays', () async {
      storage.createSync(recursive: true);
      File('${storage.path}/pending.ndjson').writeAsStringSync(
        '${jsonEncode({'kind': 'error', 'record': {'method': 'APP', 'path': 'app/crash', 'statusCode': 500, 'timestamp': DateTime.now().toUtc().toIso8601String(), 'errorMessage': 'from 0.2'}})}\n',
      );
      init();
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/errors', 'errors').single['errorMessage'], 'from 0.2');
      expect(File('${storage.path}/inflight.ndjson').existsSync(), isFalse);
    });
  });

  group('without a disk', () {
    test('a fatal error still reaches the server straight away', () async {
      // On Flutter web, and with persistCrashes off, there is nowhere durable
      // to put it. It used to sit in a list that was only read at init.
      init(persist: false);
      Sentrinel.captureError(StateError('no disk'), StackTrace.current, fatal: true);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(captured.rows('/api/ingest/errors', 'errors').single['errorMessage'],
          contains('no disk'));
    });
  });

  group('backgrounding', () {
    test('ends the session cleanly, so an OS kill is not abnormal', () async {
      init();
      await Sentrinel.onBackground();
      // The OS kills the backgrounded app: no close(), no further code.
      Sentrinel.collector?.dispose();

      final ended = captured.rows('/api/ingest/sessions', 'sessions').where((s) => s['durationMs'] != null);
      expect(ended, isNotEmpty, reason: 'the session ends with a duration');

      final second = Captured();
      init(client: second.client());
      expect(Sentrinel.previousRunCrashed, isFalse);
      await Sentrinel.flush();
      expect(second.rows('/api/ingest/sessions', 'sessions').map((s) => s['status']),
          isNot(contains('abnormal')));
    });

    test('a quick return is the same session; a long absence starts a new one', () async {
      init();
      await Sentrinel.flush();
      final first = captured.rows('/api/ingest/sessions', 'sessions').single['sessionId'];

      await Sentrinel.onBackground();
      Sentrinel.onForeground();
      Sentrinel.info('still here');
      // The marker is back: a crash from here on is still noticed.
      expect(File('${storage.path}/session.json').existsSync(), isTrue);

      final saved = Sentrinel.sessionTimeout;
      Sentrinel.sessionTimeout = Duration.zero;
      await Sentrinel.onBackground();
      Sentrinel.onForeground();
      Sentrinel.sessionTimeout = saved;
      await Sentrinel.flush();

      final ids = captured.rows('/api/ingest/sessions', 'sessions').map((s) => s['sessionId']).toSet();
      expect(ids, contains(first));
      expect(ids.length, 2);
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
