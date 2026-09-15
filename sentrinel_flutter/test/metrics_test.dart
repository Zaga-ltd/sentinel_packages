/// Custom metrics on a phone.
///
/// The caps and the folding are the same as the Node and Python registries on
/// purpose: a metric recorded from an app and from a backend has to mean the
/// same thing, or a chart that adds both up is adding two different things.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel/sentrinel.dart';
import 'package:sentrinel/src/collector.dart';
import 'package:test/test.dart';

void main() {
  group('the registry', () {
    late MetricRegistry reg;

    setUp(() => reg = MetricRegistry());

    test('folds many increments into one row', () {
      for (var i = 0; i < 2000; i++) {
        reg.record('videos.started', 'counter', 1, labels: {'quality': 'hd'});
      }
      final points = reg.drain(DateTime.utc(2026));
      expect(points, hasLength(1));
      expect(points.first['sum'], 2000);
      expect(points.first['count'], 2000);
    });

    test('label order does not split a series', () {
      reg.record('a', 'counter', 1, labels: {'x': '1', 'y': '2'});
      reg.record('a', 'counter', 1, labels: {'y': '2', 'x': '1'});
      expect(reg.drain(DateTime.utc(2026)), hasLength(1));
    });

    test('NaN and infinity are refused, not summed', () {
      reg.record('a', 'counter', double.nan);
      reg.record('a', 'counter', double.infinity);
      expect(reg.drain(DateTime.utc(2026)), isEmpty);
    });

    test('series are capped rather than growing without bound', () {
      for (var i = 0; i < kMaxSeries + 25; i++) {
        reg.record('a', 'counter', 1, labels: {'user': '$i'});
      }
      expect(reg.size, kMaxSeries);
      expect(reg.droppedSeries, 25);
    });

    test('a histogram reports percentiles', () {
      for (var i = 1; i <= 100; i++) {
        reg.record('startup.ms', 'histogram', i);
      }
      final p = reg.drain(DateTime.utc(2026)).first;
      expect(p['p50'], 50);
      expect(p['p95'], 95);
      expect(p['p99'], 99);
    });

    test('a gauge reports its last reading', () {
      for (final v in [5, 9, 2]) {
        reg.record('queue.depth', 'gauge', v);
      }
      expect(reg.drain(DateTime.utc(2026)).first['last'], 2);
    });

    test('draining resets, so a gauge that stops leaves a gap', () {
      reg.record('q', 'gauge', 1);
      reg.drain(DateTime.utc(2026));
      expect(reg.drain(DateTime.utc(2026)), isEmpty);
    });
  });

  group('shipping', () {
    test('metrics ride the flush as one payload', () async {
      final sent = <String, Map<String, dynamic>>{};
      final client = MockClient((req) async {
        sent[req.url.path] = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response('{}', 200);
      });

      final collector = SentrinelCollector(
        serverUrl: 'http://localhost:9',
        appName: 'app',
        env: 'test',
        apiKey: 'k',
        client: client,
      );
      for (var i = 0; i < 500; i++) {
        collector.metrics.record('taps', 'counter', 1, labels: {'screen': 'home'});
      }
      await collector.flush();

      final body = sent['/api/ingest/custom-metrics'];
      expect(body, isNotNull);
      expect(body!['appName'], 'app');
      final points = body['metrics'] as List;
      expect(points, hasLength(1));
      expect((points.first as Map)['sum'], 500);
    });

    test('metrics alone are enough to flush', () async {
      // A screen that counts something without making a request still has
      // telemetry worth sending; an early return on "no requests" lost it.
      var posted = false;
      final client = MockClient((req) async {
        posted = true;
        return http.Response('{}', 200);
      });
      final collector = SentrinelCollector(
        serverUrl: 'http://localhost:9', appName: 'app', env: 'test', apiKey: 'k', client: client);
      collector.metrics.record('solo', 'counter', 1);
      await collector.flush();
      expect(posted, isTrue);
    });

    test('the public API records through the collector', () async {
      final client = MockClient((req) async => http.Response('{}', 200));
      Sentrinel.init(
        serverUrl: 'http://localhost:9',
        appName: 'app',
        env: 'test',
        apiKey: 'k',
        persistCrashes: false,
        httpClient: client,
      );
      Sentrinel.count('a');
      Sentrinel.gauge('b', 3);
      Sentrinel.histogram('c', 7);
      expect(Sentrinel.collector!.metrics.size, 3);
      await Sentrinel.close();
    });
  });
}
