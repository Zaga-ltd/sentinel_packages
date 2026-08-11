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

    test('the outgoing request carries traceparent for the backend to continue', () async {
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

      expect(seen, isNotNull);
      expect(seen, matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
    });

    test("an app's own traceparent is not overwritten", () async {
      Sentrinel.init(
        serverUrl: 'https://api.test',
        appName: 'mobile-app',
        httpClient: captured.client(),
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
      expect(logs.single['attributes'],
          {'screen': 'checkout', 'tier': 'pro', 'step': 1});
    });

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
}
