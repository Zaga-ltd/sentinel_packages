// Parity with what the server now stores.
//
// Each of these is silent when it regresses: a missing route explodes the
// endpoints table one id at a time, and a log line with no owner simply never
// appears when someone asks what a user did.

import 'package:sentrinel/src/models.dart';
import 'package:test/test.dart';

void main() {
  // The route rules themselves are in route_path_test.dart, run against the
  // server's own cases.

  group('every record names its owner', () {
    test('a log line carries the consumer', () {
      final json = LogRecord(
        level: 'error',
        message: 'card declined',
        timestamp: DateTime.now(),
        consumerIdentifier: 'jane',
      ).toJson();
      expect(json['consumerIdentifier'], 'jane');
    });

    test('an anonymous log line omits the field rather than sending null', () {
      final json = LogRecord(
        level: 'info',
        message: 'started',
        timestamp: DateTime.now(),
      ).toJson();
      expect(json.containsKey('consumerIdentifier'), isFalse);
    });

    test('a request carries its route and host', () {
      final json = RequestRecord(
        id: 'r1',
        method: 'GET',
        path: '/orders/42',
        route: '/orders/{id}',
        host: 'api.example.com',
        statusCode: 200,
        responseTime: 12.5,
        timestamp: DateTime.now(),
      ).toJson();
      expect(json['route'], '/orders/{id}');
      expect(json['host'], 'api.example.com');
      // The concrete path is kept too — it is what you want to read on the row.
      expect(json['path'], '/orders/42');
    });
  });
}
