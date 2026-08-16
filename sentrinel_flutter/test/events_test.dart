// Product events are what a funnel is made of, and the two ways they go wrong
// are silent: an event with no identity is dropped by the server, and an
// anonymous id that changes every launch turns one person into many — flat
// retention, funnels that never complete across a restart, and "daily actives"
// that really means "daily launches".

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentrinel/sentrinel.dart';
import 'package:test/test.dart';

class Captured {
  final List<Map<String, dynamic>> batches = [];

  http.Client client() => MockClient((req) async {
        if (req.url.path == '/api/ingest/events') {
          batches.add(jsonDecode(req.body) as Map<String, dynamic>);
        }
        return http.Response('{"ok":true}', 200);
      });

  List<Map<String, dynamic>> get events => batches
      .expand((b) => (b['events'] as List).cast<Map<String, dynamic>>())
      .toList();
}

Directory tempDir() =>
    Directory.systemTemp.createTempSync('sentrinel-events-test');

void main() {
  group('track', () {
    test('an event reaches the events endpoint with its properties', () async {
      final cap = Captured();
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: cap.client(),
        storagePath: dir.path,
      );

      Sentrinel.track('checkout_started', properties: {'cart_value': 42});
      await Sentrinel.flush();

      final ev = cap.events.singleWhere((e) => e['name'] == 'checkout_started');
      expect(ev['kind'], 'track');
      expect((ev['properties'] as Map)['cart_value'], 42);
      // Identity rides on the envelope, not on every row.
      expect(cap.batches.first['anonymousId'], isNotEmpty);
      dir.deleteSync(recursive: true);
    });

    test('a nameless event is not sent at all', () async {
      final cap = Captured();
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: cap.client(),
        storagePath: dir.path,
      );

      Sentrinel.track('');
      Sentrinel.track('   ');
      await Sentrinel.flush();

      expect(cap.events.where((e) => e['kind'] == 'track'), isEmpty);
      dir.deleteSync(recursive: true);
    });

    test('a screen is a screen, so the server can normalise its name', () async {
      final cap = Captured();
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: cap.client(),
        storagePath: dir.path,
      );

      Sentrinel.screen('Cart');
      await Sentrinel.flush();

      expect(cap.events.singleWhere((e) => e['name'] == 'Cart')['kind'], 'screen');
      dir.deleteSync(recursive: true);
    });
  });

  group('identity', () {
    test('the anonymous id survives a restart', () async {
      final dir = tempDir();

      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: Captured().client(),
        storagePath: dir.path,
      );
      final first = Sentrinel.anonymousId;

      // Same storage, fresh init — what the next launch looks like.
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: Captured().client(),
        storagePath: dir.path,
      );

      expect(first, isNotNull);
      expect(Sentrinel.anonymousId, first);
      dir.deleteSync(recursive: true);
    });

    test('two installs are two people', () async {
      final a = tempDir();
      final b = tempDir();

      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: Captured().client(),
        storagePath: a.path,
      );
      final first = Sentrinel.anonymousId;

      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: Captured().client(),
        storagePath: b.path,
      );

      expect(Sentrinel.anonymousId, isNot(first));
      a.deleteSync(recursive: true);
      b.deleteSync(recursive: true);
    });

    test('identify attaches a user, and the anonymous id still travels', () async {
      final cap = Captured();
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: cap.client(),
        storagePath: dir.path,
      );

      final anon = Sentrinel.anonymousId;
      Sentrinel.identify('user_42');
      Sentrinel.track('subscribed');
      await Sentrinel.flush();

      expect(Sentrinel.currentUserId, 'user_42');
      final batch = cap.batches.first;
      expect(batch['userId'], 'user_42');
      // Both ids in the same payload is what lets the server stitch a person's
      // pre-login activity to their account.
      expect(batch['anonymousId'], anon);
      dir.deleteSync(recursive: true);
    });

    test('signing out reverts to anonymous', () async {
      final cap = Captured();
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: cap.client(),
        storagePath: dir.path,
      );

      Sentrinel.identify('user_42');
      Sentrinel.identify(null);
      Sentrinel.track('browsed');
      await Sentrinel.flush();

      expect(Sentrinel.currentUserId, isNull);
      expect(cap.batches.last['userId'], isNull);
      dir.deleteSync(recursive: true);
    });
  });

  group('it cannot hurt the host app', () {
    test('an unreachable server is a no-op, not a throw', () async {
      final dir = tempDir();
      Sentrinel.init(
        serverUrl: 'https://sentrinel.test',
        appName: 'app',
        env: 'test',
        httpClient: MockClient((_) async => throw const SocketException('offline')),
        storagePath: dir.path,
      );

      Sentrinel.track('checkout_started');
      await expectLater(Sentrinel.flush(), completes);
      dir.deleteSync(recursive: true);
    });
  });
}
