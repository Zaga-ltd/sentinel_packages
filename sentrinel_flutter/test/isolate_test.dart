// A crash on a background isolate has to reach the SDK.
//
// It did not. `Isolate.current.addErrorListener` covers *this* isolate, and
// `Isolate.spawn` does not inherit the spawner's error listeners — a worker
// started the ordinary way prints its stack to stderr and reports nothing.
// That makes it the worst-behaved class of failure: from the dashboard, a
// failed background job is indistinguishable from one that never ran.
//
// A worker that dies takes its work with it, not the app — so these are
// reported unhandled, sent within a second, and mark the session `errored`.
// They used to take the crash path: held on disk until the next launch and
// counted against the release as crashes the user never saw.

import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel/sentrinel.dart';
import 'package:test/test.dart';

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

/// Throws on whichever isolate runs it.
void doomedWorker(String label) {
  throw StateError('IsolateFailure: worker $label died');
}

void main() {
  late Directory storage;
  late Captured captured;

  setUp(() {
    storage = Directory.systemTemp.createTempSync('sentrinel_isolate_test');
    captured = Captured();
    Sentrinel.init(
      serverUrl: 'https://api.test',
      appName: 'mobile-app',
      env: 'prod',
      apiKey: 'k',
      storagePath: storage.path,
      httpClient: captured.client(),
    );
  });

  tearDown(() async {
    await Sentrinel.close();
    if (storage.existsSync()) storage.deleteSync(recursive: true);
  });

  /// Spawn a worker that throws, then wait for its report to be sent.
  Future<Map<String, dynamic>?> crashWorker(String label) async {
    await Isolate.spawn(doomedWorker, label, onError: isolateErrorPort);
    // The isolate has to start, throw, deliver over the port, and the report
    // then leaves on the ~1s "soon" flush.
    for (var i = 0; i < 40; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final hit = captured
          .rows('/api/ingest/errors', 'errors')
          .where((e) => '${e['errorMessage']}'.contains('worker $label died'));
      if (hit.isNotEmpty) return hit.first;
    }
    return null;
  }

  group('errors from a spawned isolate', () {
    test('are captured when the error port is passed, and sent without a flush', () async {
      final row = await crashWorker('alpha');
      expect(row, isNotNull, reason: 'no report for the spawned isolate crash');
    });

    test('are attributed to the isolate handler, unhandled, not fatal', () async {
      final row = await crashWorker('beta');
      expect(row, isNotNull);

      final attrs = row!['attributes'] as Map;
      expect(attrs['sentrinel.mechanism'], 'Isolate.onError');
      expect(attrs['sentrinel.handled'], isFalse);
      expect(attrs.containsKey('sentrinel.fatal'), isFalse);
      // Not held on disk for a next launch that has nothing to do with it.
      expect(File('${storage.path}/pending.ndjson').existsSync(), isFalse);
    });

    test('mark the session errored, not crashed', () async {
      await crashWorker('gamma');
      await Sentrinel.flush();
      final statuses = captured.rows('/api/ingest/sessions', 'sessions').map((s) => s['status']);
      expect(statuses, contains('errored'));
      expect(statuses, isNot(contains('crashed')));
    });

    test('the port exists so callers can pass it at all', () {
      // The regression that hid this: with no way to reach the port, every
      // caller wrote a plain Isolate.spawn and lost the errors silently.
      expect(isolateErrorPort, isNotNull);
      expect(isolateErrorPort, isA<SendPort>());
    });
  });
}
