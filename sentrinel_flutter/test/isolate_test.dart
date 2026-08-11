// A crash on a background isolate has to reach the SDK.
//
// It did not. `Isolate.current.addErrorListener` covers *this* isolate, and
// `Isolate.spawn` does not inherit the spawner's error listeners — a worker
// started the ordinary way prints its stack to stderr and reports nothing.
// That makes it the worst-behaved class of crash: from the dashboard, a failed
// background job is indistinguishable from one that never ran.
//
// Isolate errors are recorded as fatal, so they take the crash path — written
// to disk, delivered on the next launch. The two-launch shape below is that
// path, not test ceremony.

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

  void init(Captured c) {
    Sentrinel.init(
      serverUrl: 'https://api.test',
      appName: 'mobile-app',
      env: 'prod',
      apiKey: 'k',
      storagePath: storage.path,
      httpClient: c.client(),
    );
  }

  setUp(() {
    storage = Directory.systemTemp.createTempSync('sentrinel_isolate_test');
    captured = Captured();
    init(captured);
  });

  tearDown(() async {
    await Sentrinel.close();
    if (storage.existsSync()) storage.deleteSync(recursive: true);
  });

  /// The spool as it sits on disk, one decoded record per line.
  List<Map<String, dynamic>> spooled() {
    final file = File('${storage.path}/pending.ndjson');
    if (!file.existsSync()) return [];
    return file
        .readAsLinesSync()
        .where((l) => l.trim().isNotEmpty)
        .map((l) => jsonDecode(l) as Map<String, dynamic>)
        .toList();
  }

  group('errors from a spawned isolate', () {
    test('are captured when the error port is passed', () async {
      await Isolate.spawn(doomedWorker, 'alpha', onError: isolateErrorPort);

      // The isolate has to start, throw, and deliver over the port.
      await Future<void>.delayed(const Duration(milliseconds: 800));

      final hit = spooled().where(
        (r) => jsonEncode(r).contains('worker alpha died'),
      );
      expect(hit, isNotEmpty, reason: 'no report for the spawned isolate crash');
    });

    test('are marked fatal and attributed to the isolate handler', () async {
      await Isolate.spawn(doomedWorker, 'beta', onError: isolateErrorPort);
      await Future<void>.delayed(const Duration(milliseconds: 800));

      final row = spooled().firstWhere(
        (r) => jsonEncode(r).contains('worker beta died'),
        orElse: () => {},
      );
      expect(row, isNotEmpty, reason: 'the crash never reached the spool');

      final attrs = (row['record'] as Map)['attributes'] as Map;
      // An isolate that died took its work with it — that is a crash, not a
      // handled exception, and the mechanism should say where it came from.
      expect(attrs['sentrinel.mechanism'], 'Isolate.onError');
      expect(attrs['sentrinel.fatal'], isTrue);
    });

    test('ship on the next launch, like any other crash', () async {
      await Isolate.spawn(doomedWorker, 'gamma', onError: isolateErrorPort);
      await Future<void>.delayed(const Duration(milliseconds: 800));
      Sentrinel.collector?.dispose();

      // Launch two: fresh process, same storage.
      final second = Captured();
      init(second);
      await Sentrinel.flush();

      final errors = second.rows('/api/ingest/errors', 'errors');
      expect(
        errors.any((e) => '${e['errorMessage']}'.contains('worker gamma died')),
        isTrue,
        reason: 'the isolate crash should ship on the next launch',
      );
    });

    test('the port exists so callers can pass it at all', () {
      // The regression that hid this: with no way to reach the port, every
      // caller wrote a plain Isolate.spawn and lost the errors silently.
      expect(isolateErrorPort, isNotNull);
      expect(isolateErrorPort, isA<SendPort>());
    });
  });
}
