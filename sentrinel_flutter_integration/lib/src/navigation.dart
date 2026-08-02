/// Navigation breadcrumbs and screen context.
///
/// "NoSuchMethodError on null" tells you almost nothing. The same error with
/// "and they were on /checkout/payment, having come from /cart" is usually
/// enough to reproduce it without asking the user anything.
library;

import 'package:flutter/widgets.dart';
import 'package:sentrinel/sentrinel.dart';

/// Records route changes as breadcrumbs, and keeps the current screen on the
/// context so every error and request carries it.
///
/// ```dart
/// MaterialApp(
///   navigatorObservers: [SentrinelNavigatorObserver()],
/// )
/// ```
class SentrinelNavigatorObserver extends NavigatorObserver {
  SentrinelNavigatorObserver({this.contextKey = 'screen'});

  /// The attribute name the current route is stored under.
  final String contextKey;

  String? _current;

  /// The route as it should appear in telemetry.
  ///
  /// Prefers the declared name. An unnamed route falls back to its widget type,
  /// which is at least stable — using `toString()` would put a different hash in
  /// every record and make grouping impossible.
  static String describe(Route<dynamic>? route) {
    if (route == null) return 'unknown';
    final name = route.settings.name;
    if (name != null && name.isNotEmpty) return name;
    if (route is PageRoute) return route.runtimeType.toString();
    return route.runtimeType.toString();
  }

  void _moveTo(String? to, String from, String how) {
    _current = to;
    if (to != null) Sentrinel.setContext({contextKey: to});
    Sentrinel.addBreadcrumb(
      '$how $from → ${to ?? 'unknown'}',
      category: 'navigation',
      data: {'from': from, 'to': to, 'action': how},
    );
  }

  /// The route the user is on now, or null before the first navigation.
  String? get currentRoute => _current;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _moveTo(describe(route), describe(previousRoute), 'push');
    super.didPush(route, previousRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // After a pop the user is on the route underneath, not the one that left.
    _moveTo(describe(previousRoute), describe(route), 'pop');
    super.didPop(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    _moveTo(describe(newRoute), describe(oldRoute), 'replace');
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _moveTo(describe(previousRoute), describe(route), 'remove');
    super.didRemove(route, previousRoute);
  }
}
