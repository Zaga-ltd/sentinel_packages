/// Device facts and breadcrumbs — the context that turns a stack trace into a
/// diagnosis.
///
/// A crash report with only an exception message tells you something broke. The
/// same report with "Android 14, 4 GB, and here are the last twelve things the
/// app did" usually tells you why.
library;

// Device facts moved to `device.dart`, which answers per platform instead of
// calling `Platform` everywhere and catching the `UnsupportedError` the web
// throws back. The catch worked — this file was never the thing broken on web —
// but it made "no device context" indistinguishable from "the lookup failed",
// and it kept a `dart:io` import in a file whose remaining contents need
// nothing of the sort. Everything below is plain Dart and runs anywhere.

/// One thing the app did, kept to explain what led to a failure.
class Breadcrumb {
  Breadcrumb({
    required this.timestamp,
    required this.category,
    required this.message,
    this.data,
  });

  final DateTime timestamp;
  final String category;
  final String message;
  final Map<String, Object?>? data;

  Map<String, dynamic> toJson() => {
        'timestamp': timestamp.toUtc().toIso8601String(),
        'category': category,
        'message': message,
        if (data != null && data!.isNotEmpty) 'data': data,
      };
}

/// A bounded trail of recent activity.
///
/// Fixed size on purpose: an app that runs for hours must not accumulate an
/// unbounded list, and the twenty things immediately before a crash explain it
/// far better than the two thousand before those.
class BreadcrumbTrail {
  BreadcrumbTrail({this.limit = 25});

  final int limit;
  final List<Breadcrumb> _crumbs = [];

  void add(Breadcrumb crumb) {
    _crumbs.add(crumb);
    while (_crumbs.length > limit) {
      _crumbs.removeAt(0);
    }
  }

  void clear() => _crumbs.clear();

  int get length => _crumbs.length;

  List<Map<String, dynamic>> toJson() => _crumbs.map((c) => c.toJson()).toList();
}
