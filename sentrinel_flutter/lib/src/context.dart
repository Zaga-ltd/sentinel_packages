/// Device facts and breadcrumbs — the context that turns a stack trace into a
/// diagnosis.
///
/// A crash report with only an exception message tells you something broke. The
/// same report with "Android 14, 4 GB, and here are the last twelve things the
/// app did" usually tells you why.
library;

import 'dart:io';

/// What can be learned about the device without a plugin.
///
/// Deliberately `dart:io` only. Model name and manufacturer would need
/// device_info_plus, which is a Flutter plugin — taking that dependency would
/// stop this package working in plain Dart, where it is used for CLIs and
/// server-side jobs. These fields are the ones available everywhere.
Map<String, Object?> deviceContext() {
  try {
    return {
      'device.os': Platform.operatingSystem,
      'device.os_version': Platform.operatingSystemVersion,
      'device.locale': Platform.localeName,
      'device.cores': Platform.numberOfProcessors,
      'runtime.dart': Platform.version.split(' ').first,
    };
  } catch (_) {
    // Platform throws on the web, where none of this exists.
    return const {};
  }
}

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
