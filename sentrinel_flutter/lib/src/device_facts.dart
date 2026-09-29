/// What the server needs to know about the device, and the User-Agent that
/// says it when nothing else does.
///
/// Plain Dart, no platform imports — the values come from `device_io.dart`,
/// `device_web.dart` and `Sentrinel.setDeviceInfo`.
library;

/// The SDK's name and version, sent with every batch.
const String kSdkName = 'sentrinel.dart';
const String kSdkVersion = '0.3.0';

/// The device, in the vocabulary the API already uses for browsers: `os` is
/// `Android` / `iOS` / `macOS` / `Windows` / `Linux`, `deviceType` is
/// `mobile` / `tablet` / `desktop`.
class DeviceFacts {
  const DeviceFacts({this.os, this.osVersion, this.deviceType, this.deviceModel});

  final String? os;
  final String? osVersion;
  final String? deviceType;
  final String? deviceModel;

  DeviceFacts merge({String? os, String? osVersion, String? deviceType, String? deviceModel}) =>
      DeviceFacts(
        os: os ?? this.os,
        osVersion: osVersion ?? this.osVersion,
        deviceType: deviceType ?? this.deviceType,
        deviceModel: deviceModel ?? this.deviceModel,
      );

  /// The envelope fields `/api/ingest/events` and `/user-sessions` read in
  /// preference to the User-Agent.
  Map<String, String> toEnvelope() => {
        if (os != null) 'os': os!,
        if (osVersion != null) 'osVersion': osVersion!,
        if (deviceType != null) 'deviceType': deviceType!,
        if (deviceModel != null) 'deviceModel': deviceModel!,
      };
}

/// The `dart:io` platform name, in the server's spelling.
String? serverOsName(String? platform) => switch (platform) {
      'android' => 'Android',
      'ios' => 'iOS',
      'macos' => 'macOS',
      'windows' => 'Windows',
      'linux' => 'Linux',
      'fuchsia' => 'Fuchsia',
      null => null,
      _ => platform,
    };

/// `Version 17.4 (Build 21E213)` → `17.4`, which is what `dart:io` reports on
/// iOS and macOS. Anything else comes back unchanged — except Android, where
/// `Platform.operatingSystemVersion` is the *kernel* (`Linux 5.10.…`), and
/// reporting that as "Android 5.10" would be worse than saying nothing.
String? cleanOsVersion(String? platform, String? raw) {
  if (raw == null || raw.isEmpty) return null;
  final version = RegExp(r'Version ([0-9.]+)').firstMatch(raw)?.group(1);
  if (version != null) return version;
  if (platform == 'android') return null;
  return raw.length > 64 ? raw.substring(0, 64) : raw;
}

/// The User-Agent for telemetry posts on `dart:io`.
///
/// `dart:io` sends `Dart/3.x (dart:io)`, which the API's User-Agent parser
/// reads as an unknown desktop — so every Flutter event landed in the desktop
/// segment. These strings are built to be read by that same parser as the
/// device they came from, for servers that do not yet take the explicit
/// fields: `(Android 14; Mobile)` is an Android phone, `(iOS 17.4; iPhone)` an
/// iPhone.
String sdkUserAgent(DeviceFacts d) {
  final version = d.osVersion == null ? '' : ' ${d.osVersion}';
  final platform = switch (d.os) {
    'Android' => 'Android$version; ${d.deviceType == 'tablet' ? 'Tablet' : 'Mobile'}',
    'iOS' => 'iOS$version; ${d.deviceType == 'tablet' ? 'iPad' : 'iPhone'}',
    'macOS' => 'Macintosh; Mac OS X$version',
    'Windows' => 'Windows NT$version',
    'Linux' => 'Linux$version',
    null => 'unknown',
    _ => '${d.os}$version',
  };
  return '$kSdkName/$kSdkVersion ($platform)';
}
