// Parity with what the server now stores.
//
// Each of these is silent when it regresses: a missing route explodes the
// endpoints table one id at a time, and a log line with no owner simply never
// appears when someone asks what a user did.

import 'package:sentrinel/src/models.dart';
import 'package:test/test.dart';

void main() {
  group('route templates', () {
    test('ids collapse so one endpoint stays one endpoint', () {
      expect(routeTemplate('/orders/8f3a1b2c'), '/orders/{id}');
      expect(routeTemplate('/orders/12345'), '/orders/{id}');
      expect(
        routeTemplate('/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/orders'),
        '/users/{id}/orders',
      );
    });

    test('several ids in one path all collapse', () {
      expect(routeTemplate('/users/42/orders/99'), '/users/{id}/orders/{id}');
    });

    // The dangerous direction: merging endpoints that are not the same one.
    test('ordinary words are never mistaken for ids', () {
      expect(routeTemplate('/api/v1/orders'), '/api/v1/orders');
      expect(routeTemplate('/subscriptions'), '/subscriptions');
      expect(routeTemplate('/notifications/unread'), '/notifications/unread');
      // Long, but a word — no digits, so it stays.
      expect(routeTemplate('/recommendations'), '/recommendations');
    });

    test('a version segment survives', () {
      // `v1` is digits-adjacent but not an id; collapsing it would merge every
      // version of every endpoint into one.
      expect(routeTemplate('/v1/orders'), '/v1/orders');
    });

    test('empty and root paths are safe', () {
      expect(routeTemplate(''), '/');
      expect(routeTemplate('/'), '/');
    });
  });

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
