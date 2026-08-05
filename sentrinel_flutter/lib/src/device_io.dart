/// Device facts and default storage, where `dart:io` exists.
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
    // Some embedders restrict parts of Platform; partial context is not worth
    // an exception on the host app's startup path.
    return const {};
  }
}

/// Where crash reports go when the caller does not say.
String defaultStoragePath() => '${Directory.systemTemp.path}/sentrinel';
