// ─── FieldOps API client ─────────────────────────────────────────────────────
//
// Every call goes through `Sentrinel.httpClient()`. That wrapper records the
// request and — the part that matters for this demo — sends `traceparent`, so
// the backend plugin continues the same trace instead of starting a fresh one.
// A tap here and the server work it caused end up on one waterfall.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:sentrinel/sentrinel.dart';

import 'config.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.message, this.path);

  final int statusCode;
  final String message;
  final String path;

  @override
  String toString() => 'ApiException($statusCode on $path): $message';
}

class FieldOpsApi {
  FieldOpsApi() : _client = Sentrinel.httpClient();

  final http.Client _client;

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        // Identifies this device in the backend's Consumers view.
        'x-technician-id': Config.technicianId,
      };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${Config.backendUrl}$path').replace(queryParameters: query);

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
  }) async {
    final uri = _uri(path, query);
    Sentrinel.addBreadcrumb('$method $path', category: 'http');

    late http.Response res;
    switch (method) {
      case 'GET':
        res = await _client.get(uri, headers: _headers);
      case 'POST':
        res = await _client.post(uri, headers: _headers, body: jsonEncode(body ?? {}));
      case 'PATCH':
        res = await _client.patch(uri, headers: _headers, body: jsonEncode(body ?? {}));
      case 'DELETE':
        res = await _client.delete(uri, headers: _headers);
      default:
        throw ArgumentError('unsupported method $method');
    }

    if (res.statusCode >= 400) {
      String message = res.body;
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map && decoded['message'] is String) {
          message = decoded['message'] as String;
        }
      } catch (_) {
        // Body was not JSON; the raw text is the best we have.
      }

      // Reported, not thrown blindly: a 4xx the user caused is worth a
      // breadcrumb and a non-fatal, not a crash.
      final error = ApiException(res.statusCode, message, path);
      Sentrinel.captureError(
        error,
        StackTrace.current,
        path: path,
        attributes: {
          'http.status': res.statusCode,
          'http.method': method,
          'http.path': path,
        },
      );
      throw error;
    }

    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> bootstrap() async =>
      await _send('GET', '/api/v1/mobile/bootstrap',
          query: {'technicianId': Config.technicianId}) as Map<String, dynamic>;

  Future<List<dynamic>> workOrders({String? status}) async {
    final res = await _send('GET', '/api/v1/workorders',
        query: status == null ? null : {'status': status}) as Map<String, dynamic>;
    return res['workOrders'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> workOrder(String id) async =>
      await _send('GET', '/api/v1/workorders/$id') as Map<String, dynamic>;

  Future<List<dynamic>> parts({bool lowStock = false}) async {
    final res = await _send('GET', '/api/v1/parts',
        query: lowStock ? {'lowStock': 'true'} : null) as Map<String, dynamic>;
    return res['parts'] as List<dynamic>;
  }

  Future<List<dynamic>> customers() async {
    final res = await _send('GET', '/api/v1/customers') as Map<String, dynamic>;
    return res['customers'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> analyticsSummary() async =>
      await _send('GET', '/api/v1/analytics/summary') as Map<String, dynamic>;

  Future<List<dynamic>> notifications() async {
    final res = await _send('GET', '/api/v1/mobile/notifications') as Map<String, dynamic>;
    return res['notifications'] as List<dynamic>;
  }

  Future<List<dynamic>> search(String q) async {
    final res = await _send('GET', '/api/v1/search', query: {'q': q}) as Map<String, dynamic>;
    return res['results'] as List<dynamic>;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> startJob(String id) async =>
      await _send('POST', '/api/v1/workorders/$id/start') as Map<String, dynamic>;

  /// The deep one — reserves stock, raises an invoice, notifies the customer.
  /// One tap, a span tree several levels down on the backend.
  Future<Map<String, dynamic>> completeJob(
    String id, {
    List<Map<String, Object>> partsUsed = const [],
    int labourMinutes = 60,
  }) async =>
      await _send('POST', '/api/v1/workorders/$id/complete', body: {
        'partsUsed': partsUsed,
        'labourMinutes': labourMinutes,
      }) as Map<String, dynamic>;

  Future<Map<String, dynamic>> addNote(String id, String body) async =>
      await _send('POST', '/api/v1/workorders/$id/notes', body: {
        'author': Config.technicianId,
        'body': body,
      }) as Map<String, dynamic>;

  Future<Map<String, dynamic>> reservePart(String partId, int qty) async =>
      await _send('POST', '/api/v1/parts/$partId/reserve', body: {'qty': qty})
          as Map<String, dynamic>;

  Future<Map<String, dynamic>> sync(List<Map<String, String>> operations) async =>
      await _send('POST', '/api/v1/mobile/sync', body: {'operations': operations})
          as Map<String, dynamic>;

  /// Uploads a synthetic photo — a deliberately fat body, so payload capture
  /// and the 2MB limit both get exercised.
  Future<Map<String, dynamic>> uploadPhoto(String workOrderId, int kilobytes) async {
    final payload = base64Encode(List<int>.filled(kilobytes * 1024, 65));
    return await _send('POST', '/api/v1/mobile/photos', body: {
      'workOrderId': workOrderId,
      'dataBase64': payload,
    }) as Map<String, dynamic>;
  }

  // ── Ops levers, for the diagnostics screen ───────────────────────────────

  Future<void> slow(int ms) async =>
      await _send('GET', '/api/v1/ops/slow', query: {'ms': '$ms'});

  Future<void> flaky(double rate) async =>
      await _send('GET', '/api/v1/ops/flaky', query: {'rate': '$rate'});

  Future<void> boom() async => await _send('GET', '/api/v1/ops/boom');

  Future<void> logStorm(int count) async =>
      await _send('POST', '/api/v1/ops/logstorm', body: {'count': count, 'label': 'mobile'});
}
