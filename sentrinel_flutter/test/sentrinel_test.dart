// The properties that make this SDK worth installing:
//
//   * a request is recorded with its timing and reaches the ingest API in the
//     shape the server validates,
//   * the mobile call carries traceparent so the backend continues the same
//     trace rather than starting a new one,
//   * a failure is recorded as an error that points back at its request,
//   * and none of it can take the host app down — offline is a no-op, and the
//     buffer is bounded.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel/sentrinel.dart';
import 'package:sentrinel/src/collector.dart';
import 'package:sentrinel/src/device_facts.dart';
import 'package:sentrinel/src/models.dart';
import 'package:test/test.dart';

/// Captures what the SDK tried to POST, keyed by ingest path.
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
  group('trace context', () {
    test('traceparent is a valid W3C header', () {
      final t = TraceContext();
      expect(t.traceparent, matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
      expect(t.traceId.length, 32);
      expect(t.spanId.length, 16);
    });

    test('ids are not reused', () {
      final ids = List.generate(200, (_) => TraceContext().traceId).toSet();
      expect(ids.length, 200);
    });

    test('a valid inbound header round-trips', () {
      final original = TraceContext();
      final parsed = TraceContext.parse(original.traceparent);
      expect(parsed, isNotNull);
      expect(parsed!.traceId, original.traceId);
      expect(parsed.spanId, original.spanId);
    });

    test('malformed headers are rejected rather than half-parsed', () {
      for (final bad in [
        null,
        '',
        'garbage',
        '00-tooshort-0011223344556677-01',
        '00-${'0' * 32}-0011223344556677-01', // all-zero trace id is invalid
        '00-${'a' * 32}-${'0' * 16}-01', // all-zero span id is invalid
        '00-${'z' * 32}-0011223344556677-01', // not hex
      ]) {
        expect(TraceContext.parse(bad), isNull, reason: 'should reject: $bad');
      }
    });
  });

  group('recording a request', () {
    late Captured captured;

    setUp(() {
      captured = Captured();
      Sentrinel.clearContext();
    });

    tearDown(() async => Sentrinel.close());

    test('a successful call is sent in the ingest shape', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        apiKey: 'k',
        consumerIdentifier: 'ios_app',
        httpClient: captured.client(),
      );

      // The app's own traffic goes through a separate mock so it does not land
      // in the same capture as the telemetry.
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('{}', 200)));
      await app.get(Uri.parse('https://example.com/v1/orders'));

      await Sentrinel.flush();

      final rows = captured.rows('/api/ingest/requests', 'requests');
      expect(rows, hasLength(1));
      final row = rows.single;
      expect(row['method'], 'GET');
      expect(row['path'], '/v1/orders');
      expect(row['statusCode'], 200);
      expect(row['consumerIdentifier'], 'ios_app');
      expect(row['responseTime'], isA<num>());
      expect(row['traceId'], isA<String>());
      expect((row['traceId'] as String).length, 32);
      // The server parses this; an invalid timestamp is a 400.
      expect(DateTime.parse(row['timestamp'] as String), isA<DateTime>());
    });

    // An app is the whole project; the phone is one part of it. The module is
    // what tells its rows apart from the backend's inside that one app.
    test('the module names which part of the project sent it', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'fieldops',
        module: 'mobile',
        httpClient: captured.client(),
      );
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('{}', 200)));
      await app.get(Uri.parse('https://example.com/v1/orders'));
      await Sentrinel.flush();

      final body = captured.byPath['/api/ingest/requests']!.single;
      expect(body['appName'], 'fieldops');
      expect(body['module'], 'mobile');
    });

    test('with no module set, none is sent and the key names the part', () async {
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'fieldops', httpClient: captured.client());
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('{}', 200)));
      await app.get(Uri.parse('https://example.com/v1/orders'));
      await Sentrinel.flush();

      expect(captured.byPath['/api/ingest/requests']!.single.containsKey('module'), isFalse);
    });

    test('a propagation target gets traceparent and the identity headers', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
        tracePropagationTargets: ['example.com'],
      );

      Map<String, String>? seen;
      final app = SentrinelHttpClient(MockClient((req) async {
        seen = req.headers;
        return http.Response('{}', 200);
      }));
      await app.get(Uri.parse('https://api.example.com/v1/orders'));

      expect(seen!['traceparent'], matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
      // What the backend SDKs read to name the person and the install behind
      // the request, so a server-side error is filed under the same people.
      expect(seen!['x-sentrinel-consumer'], 'guest:${Sentrinel.deviceId}');
      expect(seen!['x-sentrinel-device'], Sentrinel.deviceId);
    });

    test('a third-party host gets nothing: no trace, no user, no install', () async {
      // Sending a user id to a payments provider or a maps API was never the
      // intent, and a traceparent they did not ask for can break a strict
      // CORS preflight on web.
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
        tracePropagationTargets: ['api.mine.com', RegExp(r'^https://internal\.')],
      );

      Map<String, String>? seen;
      final app = SentrinelHttpClient(MockClient((req) async {
        seen = req.headers;
        return http.Response('{}', 200);
      }));
      await app.get(Uri.parse('https://maps.vendor.com/tiles/1'));

      expect(seen!.containsKey('traceparent'), isFalse);
      expect(seen!.containsKey('x-sentrinel-consumer'), isFalse);
      expect(seen!.containsKey('x-sentrinel-device'), isFalse);

      // The same host spelled as a suffix match, and a RegExp target.
      expect(Sentrinel.shouldPropagate(Uri.parse('https://api.mine.com/x')), isTrue);
      expect(Sentrinel.shouldPropagate(Uri.parse('https://eu.api.mine.com/x')), isTrue);
      expect(Sentrinel.shouldPropagate(Uri.parse('https://notapi.mine.com.evil.io/x')), isFalse);
      expect(Sentrinel.shouldPropagate(Uri.parse('https://internal.corp/x')), isTrue);
    });

    test('with no targets configured, nothing is propagated', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      String? seen;
      final app = SentrinelHttpClient(MockClient((req) async {
        seen = req.headers['traceparent'];
        return http.Response('{}', 200);
      }));
      await app.get(Uri.parse('https://example.com/v1/orders'));
      expect(seen, isNull);
    });

    test("an app's own traceparent is not overwritten", () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
        tracePropagationTargets: ['example.com'],
      );

      const mine = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
      String? seen;
      final app = SentrinelHttpClient(MockClient((req) async {
        seen = req.headers['traceparent'];
        return http.Response('{}', 200);
      }));
      await app.get(Uri.parse('https://example.com/x'), headers: {'traceparent': mine});

      expect(seen, mine);
    });

    test('a 4xx also produces an error that points at its request', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );

      final app = SentrinelHttpClient(
          MockClient((_) async => http.Response('nope', 422)));
      await app.post(Uri.parse('https://example.com/v1/pay'));
      await Sentrinel.flush();

      final requests = captured.rows('/api/ingest/requests', 'requests');
      final errors = captured.rows('/api/ingest/errors', 'errors');
      expect(errors, hasLength(1));
      expect(errors.single['statusCode'], 422);
      // This is what lets an issue open the exact failing request.
      expect(errors.single['requestLogId'], requests.single['id']);
      expect(errors.single['traceId'], requests.single['traceId']);
    });

    test('a transport failure is recorded and rethrown, not swallowed', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );

      final app = SentrinelHttpClient(
          MockClient((_) async => throw http.ClientException('offline')));

      await expectLater(
        app.get(Uri.parse('https://example.com/v1/orders')),
        throwsA(isA<http.ClientException>()),
      );
      await Sentrinel.flush();

      final rows = captured.rows('/api/ingest/requests', 'requests');
      // 0, not a made-up 5xx: nothing ever reached a server.
      expect(rows.single['statusCode'], 0);
      expect(rows.single['errorMessage'], contains('offline'));
    });

    test('secrets in the URL never leave the device', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );

      final ok = SentrinelHttpClient(MockClient((_) async => http.Response('{}', 200)));
      await ok.get(Uri.parse('https://bob:hunter2@example.com/v1/login?token=s3cret#frag'));
      // ClientException.toString() ends in `uri=<the full URL>`.
      final down = SentrinelHttpClient(MockClient((req) async =>
          throw http.ClientException('offline', req.url)));
      await expectLater(
        down.get(Uri.parse('https://example.com/v1/reset?email=jane@x.io&code=991')),
        throwsA(isA<http.ClientException>()),
      );
      await Sentrinel.flush();

      final everything = jsonEncode(captured.byPath);
      expect(everything, isNot(contains('s3cret')));
      expect(everything, isNot(contains('hunter2')));
      expect(everything, isNot(contains('jane@x.io')));
      expect(everything, isNot(contains('991')));

      final span = captured.rows('/api/ingest/traces', 'traces').first['spans'][0];
      expect(span['attributes']['http.url'], 'https://example.com/v1/login');
    });

    test('an HTTP error is filed under its route, not the raw path', () async {
      // The server groups errors by endpoint. `/orders/8814` and `/orders/9921`
      // are one endpoint, and must not become two.
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('', 404)));
      await app.get(Uri.parse('https://example.com/orders/8814'));
      await Sentrinel.flush();

      final error = captured.rows('/api/ingest/errors', 'errors').single;
      expect(error['path'], '/orders/{id}');
      expect(error['attributes']['url.path'], '/orders/8814');
      final request = captured.rows('/api/ingest/requests', 'requests').single;
      expect(request['path'], '/orders/8814', reason: 'the row keeps what was requested');
      expect(request['route'], '/orders/{id}');
    });

    test('spans leave in one batch, not one request each', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('{}', 200)));
      for (var i = 0; i < 20; i++) {
        await app.get(Uri.parse('https://example.com/v1/items/$i'));
      }
      await Sentrinel.flush();

      final posts = captured.byPath['/api/ingest/traces']!;
      expect(posts, hasLength(1));
      final traces = (posts.single['traces'] as List).cast<Map<String, dynamic>>();
      expect(traces, hasLength(20));
      final one = traces.first;
      expect(one['traceId'], hasLength(32));
      expect(one['name'], 'GET /v1/items/{id}');
      expect(one['statusCode'], 200);
      expect(DateTime.parse(one['startTime'] as String), isA<DateTime>());
      expect((one['spans'] as List).single['id'], hasLength(16));
    });
  });

  group('context and logs', () {
    late Captured captured;
    setUp(() {
      captured = Captured();
      Sentrinel.clearContext();
    });
    tearDown(() async => Sentrinel.close());

    test('context set once rides on every later record', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      Sentrinel.setContext({'screen': 'checkout', 'tier': 'pro'});
      Sentrinel.info('Checkout opened', category: 'ui', attributes: {'step': 1});
      await Sentrinel.flush();

      final logs = captured.rows('/api/ingest/logs', 'logs');
      expect(logs, hasLength(1));
      expect(logs.single['message'], 'Checkout opened');
      expect(logs.single['category'], 'ui');
      expect(logs.single['attributes'], {
        'device.id': Sentrinel.deviceId,
        'screen': 'checkout',
        'tier': 'pro',
        'step': 1,
      });
    });

    test('a value JSON cannot hold does not cost the batch', () async {
      // A DateTime in one property used to throw inside jsonEncode, and the
      // catch-all around the post dropped every record that flush carried.
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      final when = DateTime.utc(2026, 9, 1, 12);
      Sentrinel.info('with a date', attributes: {'at': when, 'ratio': double.nan});
      Sentrinel.info('plain');
      Sentrinel.track('bought', properties: {'at': when, 'tier': _Tier.gold});
      Sentrinel.addBreadcrumb('crumb', data: {'at': when});
      Sentrinel.captureError(StateError('x'), null, attributes: {'obj': Object()});
      await Sentrinel.flush();

      final logs = captured.rows('/api/ingest/logs', 'logs');
      expect(logs, hasLength(2));
      expect(logs.first['attributes']['at'], '2026-09-01T12:00:00.000Z');
      expect(logs.first['attributes']['ratio'], isNull);
      final events = captured.rows('/api/ingest/events', 'events');
      expect(events.single['properties'], {'at': '2026-09-01T12:00:00.000Z', 'tier': 'gold'});
      expect(captured.rows('/api/ingest/errors', 'errors'), hasLength(1));
    });

    test('beforeSend rewrites or drops any record', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
        beforeSend: (kind, record) {
          if (kind == 'log' && record['message'] == 'secret') return null;
          if (kind == 'error') return {...record, 'errorMessage': '[redacted]'};
          return record;
        },
      );
      Sentrinel.info('secret');
      Sentrinel.info('fine');
      Sentrinel.captureError(StateError('card 4242 4242 4242 4242'), null);
      await Sentrinel.flush();

      expect(captured.rows('/api/ingest/logs', 'logs').map((l) => l['message']), ['fine']);
      expect(captured.rows('/api/ingest/errors', 'errors').single['errorMessage'], '[redacted]');
    });

    test('a beforeSend that throws drops the record rather than sending it raw', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
        beforeSend: (kind, record) => throw StateError('bug in the hook'),
      );
      Sentrinel.info('would have been filtered');
      await Sentrinel.flush();
      expect(captured.rows('/api/ingest/logs', 'logs'), isEmpty);
    });

    test('the SDK and the device travel with the batch', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      Sentrinel.setDeviceInfo(model: 'Pixel 8', osVersion: '14', deviceType: 'mobile');
      Sentrinel.track('opened');
      Sentrinel.info('x');
      await Sentrinel.flush();

      final events = captured.byPath['/api/ingest/events']!.single;
      expect(events['deviceModel'], 'Pixel 8');
      expect(events['osVersion'], '14');
      expect(events['deviceType'], 'mobile');
      expect(events['os'], isNotNull);
      final logs = captured.byPath['/api/ingest/logs']!.single;
      expect(logs['sdk'], {'name': 'sentrinel.dart', 'version': kSdkVersion});
    });
  });

  group('the User-Agent reads as the device it came from', () {
    // `Dart/3.x (dart:io)` parsed as an unknown desktop on the server, so every
    // Flutter event landed in the desktop segment.
    test('android and iOS phones and tablets', () {
      expect(
        sdkUserAgent(const DeviceFacts(os: 'Android', osVersion: '14', deviceType: 'mobile')),
        'sentrinel.dart/$kSdkVersion (Android 14; Mobile)',
      );
      expect(
        sdkUserAgent(const DeviceFacts(os: 'Android', deviceType: 'tablet')),
        'sentrinel.dart/$kSdkVersion (Android; Tablet)',
      );
      expect(
        sdkUserAgent(const DeviceFacts(os: 'iOS', osVersion: '17.4', deviceType: 'mobile')),
        'sentrinel.dart/$kSdkVersion (iOS 17.4; iPhone)',
      );
      expect(
        sdkUserAgent(const DeviceFacts(os: 'iOS', osVersion: '17.4', deviceType: 'tablet')),
        'sentrinel.dart/$kSdkVersion (iOS 17.4; iPad)',
      );
    });

    test('the OS version is the OS, not the kernel', () {
      expect(cleanOsVersion('ios', 'Version 17.4 (Build 21E213)'), '17.4');
      expect(cleanOsVersion('macos', 'Version 14.4.1 (Build 23E224)'), '14.4.1');
      // dart:io on Android reports the Linux kernel; "Android 5.10" would lie.
      expect(cleanOsVersion('android', 'Linux 5.10.198-android13-4 #1 SMP'), isNull);
    });

    test('is sent on every telemetry post', () async {
      String? ua;
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: MockClient((req) async {
          ua = req.headers['user-agent'];
          return http.Response('{}', 200);
        }),
      );
      Sentrinel.info('x');
      await Sentrinel.flush();
      await Sentrinel.close();
      expect(ua, startsWith('sentrinel.dart/$kSdkVersion ('));
    });
  });

  group('captured errors', () {
    late Captured captured;
    setUp(() => captured = Captured());
    tearDown(() async => Sentrinel.close());

    test('captureError records the type and the stack', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
      );
      try {
        throw StateError('boom');
      } catch (e, s) {
        Sentrinel.captureError(e, s, path: 'checkout');
      }
      await Sentrinel.flush();

      final errors = captured.rows('/api/ingest/errors', 'errors');
      expect(errors.single['errorType'], 'StateError');
      expect(errors.single['errorMessage'], contains('boom'));
      expect(errors.single['stackTrace'], isNotEmpty);
      expect(errors.single['path'], 'checkout');
    });
  });

  group('it cannot take the app down', () {
    tearDown(() async => Sentrinel.close());

    test('calls before init are no-ops rather than crashes', () {
      expect(Sentrinel.isInitialised, isFalse);
      expect(() => Sentrinel.info('nobody is listening'), returnsNormally);
      expect(() => Sentrinel.captureError(StateError('x'), null), returnsNormally);
    });

    test('an unreachable server does not throw into the app', () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: MockClient((_) async => throw http.ClientException('down')),
      );
      Sentrinel.info('while offline');
      // The whole point: flushing into the void completes normally.
      await expectLater(Sentrinel.flush(), completes);
    });

    test('the buffer is bounded, and says how much it dropped', () async {
      final collector = SentrinelCollector(
        serverUrl: 'https://api.test',
        appName: 'a',
        env: 'test',
        apiKey: null,
        client: MockClient((_) async => http.Response('{}', 200)),
      );
      for (var i = 0; i < kMaxBufferedLogs + 40; i++) {
        collector.recordLog(LogRecord(
          level: 'info',
          message: 'line $i',
          timestamp: DateTime.now(),
        ));
      }
      expect(collector.pending, kMaxBufferedLogs);
      expect(collector.droppedRecords, 40);
      collector.dispose();
    });

    test('a full replay buffer keeps the newest record', () async {
      // It used to drop the oldest *and* return without adding the new one.
      final captured = Captured();
      final collector = SentrinelCollector(
        serverUrl: 'https://api.test',
        appName: 'a',
        env: 'test',
        apiKey: null,
        client: captured.client(),
      );
      for (var i = 0; i <= kMaxBufferedErrors; i++) {
        collector.recordRaw('error', {'method': 'APP', 'path': 'app', 'errorMessage': 'n$i'});
      }
      await collector.flush();
      final messages = captured.rows('/api/ingest/errors', 'errors').map((e) => e['errorMessage']);
      expect(messages, contains('n$kMaxBufferedErrors'));
      expect(messages, isNot(contains('n0')));
      collector.dispose();
    });

    test('initialising again sends what the first one buffered', () async {
      final first = Captured();
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'a', httpClient: first.client());
      Sentrinel.info('buffered before re-init');
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'a', httpClient: Captured().client());
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(first.rows('/api/ingest/logs', 'logs').map((l) => l['message']),
          contains('buffered before re-init'));
    });

    test("a client the app passed in is not closed by Sentrinel", () async {
      var closed = false;
      final mine = _CloseTracking(() => closed = true);
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'a', httpClient: mine);
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'a', httpClient: mine);
      await Sentrinel.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(closed, isFalse);
    });

    test('close twice is harmless', () async {
      Sentrinel.init(serverUrl: 'https://api.test', appName: 'a', httpClient: Captured().client());
      await Sentrinel.close();
      await expectLater(Sentrinel.close(), completes);
    });

    test('never more than four posts in flight', () async {
      var active = 0;
      var peak = 0;
      final collector = SentrinelCollector(
        serverUrl: 'https://api.test',
        appName: 'a',
        env: 'test',
        apiKey: null,
        client: MockClient((_) async {
          active++;
          if (active > peak) peak = active;
          await Future<void>.delayed(const Duration(milliseconds: 10));
          active--;
          return http.Response('{}', 200);
        }),
      );
      // Requests + metrics + errors + logs + spans + events + sessions + custom
      // metrics: eight endpoints in one flush.
      collector.anonymousId = 'anon';
      collector.recordRequest(RequestRecord(
          id: 'r', method: 'GET', path: '/x', statusCode: 500, responseTime: 1, timestamp: DateTime.now()));
      collector.recordError(ErrorRecord(method: 'GET', path: '/x', statusCode: 500, timestamp: DateTime.now()));
      collector.recordLog(LogRecord(level: 'info', message: 'm', timestamp: DateTime.now()));
      collector.recordSpan(SpanRecord(
          id: 's', traceId: 't' * 32, name: 'n', startTime: DateTime.now(), durationMs: 1));
      collector.recordEvent(EventRecord(name: 'e'));
      collector.recordSession(SessionRecord(sessionId: 's', status: 'ok', startedAt: DateTime.now()));
      collector.metrics.record('m', 'counter', 1);
      await collector.flush();
      expect(peak, lessThanOrEqualTo(kMaxConcurrentPosts));
      collector.dispose();
    });
  });

  // The dashboard reads two different things from one flush: the request rows
  // feed the log view, and a per-endpoint rollup feeds every headline number —
  // request count, error rate, p95, and the Traffic and Performance charts.
  //
  // Sending only the rows is not a partial integration, it is an invisible
  // one: a Flutter app that was reporting correctly showed "0 requests, 0.0 %,
  // 0 ms" on the Apps page, which is precisely the screen someone opens to
  // check whether the SDK works at all. Nothing failed and nothing warned.
  group('the endpoint rollup', () {
    Future<Captured> flushRequests(List<RequestRecord> records) async {
      final captured = Captured();
      final collector = SentrinelCollector(
        serverUrl: 'https://api.test',
        appName: 'a',
        env: 'test',
        apiKey: 'k',
        client: captured.client(),
      );
      for (final r in records) {
        collector.recordRequest(r);
      }
      await collector.flush();
      collector.dispose();
      return captured;
    }

    RequestRecord req({
      String method = 'GET',
      String path = '/api/v1/jobs',
      int statusCode = 200,
      double responseTime = 100,
      String? consumer,
    }) =>
        RequestRecord(
          id: 'r${DateTime.now().microsecondsSinceEpoch}$responseTime$statusCode',
          method: method,
          path: path,
          statusCode: statusCode,
          responseTime: responseTime,
          timestamp: DateTime.now(),
          consumerIdentifier: consumer,
        );

    test('a flush that sends requests also sends metrics', () async {
      final captured = await flushRequests([req()]);
      expect(captured.byPath['/api/ingest/requests'], isNotNull);
      expect(
        captured.byPath['/api/ingest/metrics'],
        isNotNull,
        reason: 'without this the Apps page reads zero for a working app',
      );
    });

    test('ids in the path fold into one route row', () async {
      // Grouped by raw path, `/orders/1` and `/orders/2` were two rows that the
      // server then normalised onto the same endpoint.
      final captured = await flushRequests([
        req(path: '/api/v1/orders/8814'),
        req(path: '/api/v1/orders/9921'),
        req(path: '/api/v1/orders/5a89df16-88a6-462d-89d9-828207ea459f', consumer: 'u1'),
        req(path: '/api/v1/orders/5a89df16-88a6-462d-89d9-828207ea4000', consumer: 'u1'),
      ]);

      final endpoints = captured.rows('/api/ingest/metrics', 'endpoints');
      expect(endpoints.map((e) => e['path']).toSet(),
          {'/api/v1/orders/{id}', '/api/v1/orders/{uuid}'});
      expect(endpoints.firstWhere((e) => e['path'] == '/api/v1/orders/{id}')['requestCount'], 2);
      final consumers = captured.rows('/api/ingest/metrics', 'consumers');
      expect(consumers.single['path'], '/api/v1/orders/{uuid}');
      expect(consumers.single['requestCount'], 2);
      // No deploy marker from a phone: mixed releases in the field would flip
      // it on every flush.
      expect(captured.byPath['/api/ingest/metrics']!.single.containsKey('version'), isFalse);
    });

    test('requests are grouped by method and path', () async {
      final captured = await flushRequests([
        req(path: '/api/v1/jobs'),
        req(path: '/api/v1/jobs'),
        req(path: '/api/v1/parts'),
        req(method: 'POST', path: '/api/v1/jobs'),
      ]);

      final endpoints = captured.rows('/api/ingest/metrics', 'endpoints');
      expect(endpoints.length, 3);

      final getJobs = endpoints.firstWhere(
        (e) => e['method'] == 'GET' && e['path'] == '/api/v1/jobs',
      );
      expect(getJobs['requestCount'], 2);
    });

    test('errors are counted separately, and status codes are kept', () async {
      final captured = await flushRequests([
        req(statusCode: 200),
        req(statusCode: 200),
        req(statusCode: 404),
        req(statusCode: 500),
      ]);

      final endpoint = captured.rows('/api/ingest/metrics', 'endpoints').single;
      expect(endpoint['requestCount'], 4);
      expect(endpoint['successCount'], 2);
      // 4xx counts as an error here because the dashboard's error rate is
      // "requests that did not succeed", not "requests the server broke on".
      expect(endpoint['errorCount'], 2);
      expect(endpoint['statusCodes'], {'200': 2, '404': 1, '500': 1});
    });

    test('percentiles interpolate the way the server plugin does', () async {
      // 1..100ms. p95 over a sorted list of 100 with linear interpolation sits
      // at index 94.05 — between 95 and 96 — not at a round bucket. Matching
      // the server's method is the point: a p95 that means one thing on mobile
      // and another on the backend is worse than no p95.
      final captured = await flushRequests([
        for (var ms = 1; ms <= 100; ms++) req(responseTime: ms.toDouble()),
      ]);

      final endpoint = captured.rows('/api/ingest/metrics', 'endpoints').single;
      expect(endpoint['minResponseTime'], 1);
      expect(endpoint['maxResponseTime'], 100);
      expect(endpoint['avgResponseTime'], closeTo(50.5, 0.01));
      expect(endpoint['p50ResponseTime'], closeTo(50.5, 0.01));
      expect(endpoint['p95ResponseTime'], closeTo(95.05, 0.01));
      expect(endpoint['p99ResponseTime'], closeTo(99.01, 0.01));
    });

    test('consumers are rolled up per endpoint', () async {
      final captured = await flushRequests([
        req(consumer: 'tech-01'),
        req(consumer: 'tech-01', statusCode: 500),
        req(consumer: 'tech-02'),
      ]);

      final consumers = captured.rows('/api/ingest/metrics', 'consumers');
      expect(consumers.length, 2);

      final one = consumers.firstWhere((c) => c['identifier'] == 'tech-01');
      expect(one['requestCount'], 2);
      expect(one['errorCount'], 1);
    });

    test('a request with no consumer does not invent one', () async {
      // Bucketing these under "anonymous" would put a row in the Consumers
      // table that nobody can contact, filter by, or act on.
      final captured = await flushRequests([req(), req(consumer: 'tech-01')]);

      final consumers = captured.rows('/api/ingest/metrics', 'consumers');
      expect(consumers.length, 1);
      expect(consumers.single['identifier'], 'tech-01');
    });

    test('a flush with no requests sends no metrics', () async {
      final captured = Captured();
      final collector = SentrinelCollector(
        serverUrl: 'https://api.test',
        appName: 'a',
        env: 'test',
        apiKey: 'k',
        client: captured.client(),
      );
      collector.recordLog(
        LogRecord(level: 'info', message: 'no traffic', timestamp: DateTime.now()),
      );
      await collector.flush();
      collector.dispose();

      expect(captured.byPath['/api/ingest/logs'], isNotNull);
      expect(captured.byPath['/api/ingest/metrics'], isNull);
    });
  });

  group('who the traffic belongs to', () {
    // The Consumers page listed "mobile_android" and "mobile_ios" and no
    // people: signed-out traffic was filed under init's consumerIdentifier, so
    // every signed-out user on a platform was one consumer. Each install is
    // its own guest now, and identify() moves it to the person.
    setUp(() {
      Sentrinel.init(
        serverUrl: 'http://localhost:9',
        appName: 'test',
        env: 'test',
        apiKey: 'k',
        persistCrashes: false,
      );
    });

    tearDown(Sentrinel.close);

    test('a signed-out install is its own guest', () {
      expect(Sentrinel.deviceId, hasLength(32));
      expect(Sentrinel.consumer, 'guest:${Sentrinel.deviceId}');
    });

    test('identifying a user attributes their traffic to them', () {
      Sentrinel.identify('user_42');
      expect(Sentrinel.consumer, 'user_42');
      expect(Sentrinel.currentUserId, 'user_42');
    });

    test('signing out returns to this install, not to a shared bucket', () {
      Sentrinel.identify('user_42');
      Sentrinel.identify(null);
      expect(Sentrinel.consumer, 'guest:${Sentrinel.deviceId}');
      expect(Sentrinel.currentUserId, isNull);
    });

    test('a blank id is not an identity', () {
      Sentrinel.identify('   ');
      expect(Sentrinel.consumer, 'guest:${Sentrinel.deviceId}');
      expect(Sentrinel.currentUserId, isNull);
    });

    test('setConsumer pins something that is not the signed-in user', () {
      Sentrinel.identify('user_42');
      Sentrinel.setConsumer('tenant_7');
      expect(Sentrinel.consumer, 'tenant_7');
      Sentrinel.setConsumer(null);
      expect(Sentrinel.consumer, 'user_42');
    });

    test("init's consumerIdentifier is an override until identify", () async {
      Sentrinel.init(
        serverUrl: 'http://localhost:9',
        appName: 'test',
        env: 'test',
        consumerIdentifier: 'kiosk_3',
        persistCrashes: false,
      );
      expect(Sentrinel.consumer, 'kiosk_3');
      Sentrinel.identify('user_42');
      expect(Sentrinel.consumer, 'user_42');
      Sentrinel.identify(null);
      expect(Sentrinel.consumer, 'guest:${Sentrinel.deviceId}');
    });

    test('every record carries the install id', () async {
      final captured = Captured();
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'test',
        httpClient: captured.client(),
        persistCrashes: false,
      );
      final app = SentrinelHttpClient(MockClient((_) async => http.Response('', 500)));
      await app.get(Uri.parse('https://example.com/x'));
      Sentrinel.info('x');
      Sentrinel.captureError(StateError('e'), null);
      await Sentrinel.flush();

      final id = Sentrinel.deviceId;
      expect(captured.rows('/api/ingest/requests', 'requests').single['attributes']['device.id'], id);
      expect(captured.rows('/api/ingest/logs', 'logs').single['attributes']['device.id'], id);
      for (final e in captured.rows('/api/ingest/errors', 'errors')) {
        expect(e['attributes']['device.id'], id);
        expect(e['consumerIdentifier'], 'guest:$id');
      }
      final span = captured.rows('/api/ingest/traces', 'traces').single['spans'][0];
      expect(span['attributes']['device.id'], id);
    });
  });
}

enum _Tier { gold }

class _CloseTracking extends http.BaseClient {
  _CloseTracking(this.onClose);
  final void Function() onClose;
  final _inner = MockClient((_) async => http.Response('{}', 200));

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => _inner.send(request);

  @override
  void close() => onClose();
}
