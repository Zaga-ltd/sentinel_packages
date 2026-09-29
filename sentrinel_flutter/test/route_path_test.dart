// The client's route identity must be the server's, character for character.
//
// Every case below is copied from apps/api/tests/route-path.test.ts. The API
// normalises the path of every rollup row and error it stores; when this SDK
// collapsed ids by its own rules — `{id}` where the server writes `{uuid}`,
// 8-character hex where the server wants 16 — the two spellings of one route
// landed as separate endpoint rows. If a server rule changes, this file is the
// one that has to change with it.

import 'package:sentrinel/src/models.dart';
import 'package:test/test.dart';

void main() {
  group('identifiers are collapsed', () {
    const cases = <String, String>{
      '/orders/8814': '/orders/{id}',
      '/api/v1/users/1': '/api/v1/users/{id}',
      '/api/v1/voca/scenarios/5a89df16-88a6-462d-89d9-828207ea459f/turn':
          '/api/v1/voca/scenarios/{uuid}/turn',
      '/telesales/merchants/merchant-8f5v2Q2SkT/attempts': '/telesales/merchants/{id}/attempts',
      '/campaigns/targets/target-17607a183c8a4c3da81d2d92db46fb36/call':
          '/campaigns/targets/{id}/call',
      '/telesales/merchants/merchant--JMmb1__ya/attempts': '/telesales/merchants/{id}/attempts',
      '/v1/regions/m87xEBKR2hjN/districts/': '/v1/regions/{id}/districts/',
      '/sessions/a3f9c1e8b7d24f60a3f9c1e8b7d24f60': '/sessions/{hash}',
      '/uploads/kyc/2026-08/614ce712-2300-4479-8295-beaad8de0bdc.jpg':
          '/uploads/kyc/{date}/{uuid}.jpg',
      '/exports/2026-08-14/report-9f8e7d6c5b4a3210.csv': '/exports/{date}/{id}.csv',
      '/t/user-a1B2c3D4': '/t/{id}',
      '/t/x/a1B2c3D4e5': '/t/x/{id}',
    };
    cases.forEach((raw, expected) {
      test(raw, () => expect(normaliseRoutePath(raw), expected));
    });
  });

  group('real routes are left alone', () {
    const survivors = [
      '/lms/api/v1/dapa/loans/call-histories',
      '/dashboard/agent-call-stats',
      '/telesales/agents-for-reassign',
      '/followups/all-followups',
      '/cau-supervisor/queue',
      '/api/v3/confessl/app-config',
      '/v1/payment-methods/',
      '/lms/api/v1/dapa/payments/loans-paids',
      '/submissions/channel-submissions',
      '/ai-listener/events',
      '/merchants/clusters',
      '/t/a1B2c3D',
      '/t/abcdefghij',
      '/v2/devices/',
      '/v1/news/',
      '/api/v1/users',
      // Words that are valid hex, and long words: the server's rules leave
      // them alone, so the client must too.
      '/facade',
      '/notifications/unread',
      '/recommendations',
    ];
    for (final path in survivors) {
      test(path, () => expect(normaliseRoutePath(path), path));
    }
  });

  group('edges', () {
    test('a path the framework already parameterised is unchanged', () {
      expect(normaliseRoutePath('/orders/:id'), '/orders/:id');
      expect(normaliseRoutePath('/orders/{id}'), '/orders/{id}');
      expect(normaliseRoutePath('/orders/[id]'), '/orders/[id]');
    });

    test('it is idempotent', () {
      final once = normaliseRoutePath('/uploads/2026-08/614ce712-2300-4479-8295-beaad8de0bdc.jpg');
      expect(normaliseRoutePath(once), once);
    });

    test('query strings and fragments are not part of a route', () {
      expect(normaliseRoutePath('/search?q=hello&page=3'), '/search');
      expect(normaliseRoutePath('/docs#section-4'), '/docs');
    });

    test('empty and absent paths do not throw', () {
      expect(normaliseRoutePath(''), '');
      expect(normaliseRoutePath(null), '');
    });

    test('short numbers still collapse, short words do not', () {
      expect(normaliseRoutePath('/api/v1/x/5'), '/api/v1/x/{id}');
      expect(normaliseRoutePath('/api/v2'), '/api/v2');
    });

    test('trailing slashes and the root survive', () {
      expect(normaliseRoutePath('/'), '/');
      expect(normaliseRoutePath('/v1/news/'), '/v1/news/');
    });

    test('several ids in one path all collapse', () {
      expect(normaliseRoutePath('/users/42/orders/99'), '/users/{id}/orders/{id}');
    });
  });
}
