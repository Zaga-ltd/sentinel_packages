/// Device facts and default storage, where `dart:io` exists.
library;

import 'dart:io';

import 'device_facts.dart';

/// False here; true in `device_web.dart`. Decides same-origin propagation and
/// whether a User-Agent can be set at all.
const bool runningOnWeb = false;

/// What can be learned about the device without a plugin.
///
/// Deliberately `dart:io` only. Model name and manufacturer would need
/// device_info_plus, which is a Flutter plugin — taking that dependency would
/// stop this package working in plain Dart, where it is used for CLIs and
/// server-side jobs. Apps that have it pass the extra facts through
/// `Sentrinel.setDeviceInfo`.
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

/// The device as the ingest API wants it. A phone OS is assumed to be a
/// phone; a Flutter app on a tablet says so through `setDeviceInfo` (the
/// Flutter package does it from the screen size).
DeviceFacts platformFacts() {
  try {
    final platform = Platform.operatingSystem;
    return DeviceFacts(
      os: serverOsName(platform),
      osVersion: cleanOsVersion(platform, Platform.operatingSystemVersion),
      deviceType: switch (platform) {
        'android' || 'ios' => 'mobile',
        'macos' || 'windows' || 'linux' => 'desktop',
        _ => null,
      },
    );
  } catch (_) {
    return const DeviceFacts();
  }
}

/// Where crash reports go when the caller does not say.
String defaultStoragePath() => '${Directory.systemTemp.path}/sentrinel';
