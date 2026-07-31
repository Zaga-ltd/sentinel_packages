// Sends real telemetry from the Dart SDK to a running Sentrinel API.
//
//   dart run example/live_check.dart <serverUrl> <apiKey>
//
// Not a test — a smoke check you can point at a real deployment to prove the
// SDK and the server agree on the wire format.
import 'package:http/http.dart' as http;
import 'package:sentrinel/sentrinel.dart';

Future<void> main(List<String> args) async {
  final serverUrl = args.isNotEmpty ? args[0] : 'http://localhost:3011';
  final apiKey = args.length > 1 ? args[1] : null;

  Sentrinel.init(
    serverUrl: serverUrl,
    appName: 'flutter-demo',
    env: 'prod',
    apiKey: apiKey,
    consumerIdentifier: 'ios_app',
    flushInterval: const Duration(seconds: 2),
  );
  Sentrinel.setContext({'screen': 'checkout', 'buildChannel': 'beta'});

  final client = Sentrinel.httpClient(
    inner: MockishClient(),
  );

  await client.get(Uri.parse('https://backend.test/v1/orders'));
  await client.post(Uri.parse('https://backend.test/v1/payments'));
  try {
    await client.get(Uri.parse('https://backend.test/v1/missing'));
  } catch (_) {}

  Sentrinel.info('Checkout opened', category: 'ui', attributes: {'items': 3});
  Sentrinel.warn('Slow image load', category: 'ui', attributes: {'ms': 1840});
  try {
    throw StateError('cart desync');
  } catch (e, s) {
    Sentrinel.captureError(e, s, path: 'checkout');
  }

  await Sentrinel.flush();
  await Sentrinel.close();
  print('sent: 3 requests, 1 error from a 500, 2 logs, 1 captured exception');
}

/// Stands in for the app's real backend so the check needs only Sentrinel up.
class MockishClient extends http.BaseClient {
  final _inner = http.Client();
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final status = request.url.path.contains('missing') ? 500 : 200;
    return http.StreamedResponse(
      Stream.value('{"ok":true}'.codeUnits),
      status,
      contentLength: 11,
      request: request,
    );
  }
  @override
  void close() => _inner.close();
}
