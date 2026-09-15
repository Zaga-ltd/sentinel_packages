/// Build-time configuration.
///
/// Everything here comes from `--dart-define`, so no key is compiled into a
/// checked-in file:
///
/// ```
/// flutter run \
///   --dart-define=SENTRINEL_URL=http://localhost:3001 \
///   --dart-define=SENTRINEL_KEY=snt_dev_… \
///   --dart-define=FIELDOPS_API=http://localhost:4400
/// ```
///
/// On an iOS simulator `localhost` reaches the host machine. On an Android
/// emulator it does not — use `http://10.0.2.2:<port>` there.
library;

class Config {
  /// Where the Sentrinel API lives — the telemetry destination.
  static const sentrinelUrl = String.fromEnvironment(
    'SENTRINEL_URL',
    defaultValue: 'http://localhost:3001',
  );

  /// Ingest key for the mobile app. Without it ingest is rejected with 403.
  static const sentrinelKey = String.fromEnvironment('SENTRINEL_KEY');

  /// The key as the SDK wants it: null rather than empty when unset.
  static String? get apiKey => sentrinelKey.isEmpty ? null : sentrinelKey;

  /// The FieldOps backend this app talks to.
  static const backendUrl = String.fromEnvironment(
    'FIELDOPS_API',
    defaultValue: 'http://localhost:4400',
  );

  /// The project in Sentrinel — the same app the backend reports into, so a
  /// sync started here can be followed into the request and query it caused.
  static const appName = 'fieldops';

  /// Which part of the project this is. The backend reports as "backend".
  static const module = 'mobile';

  static const env = String.fromEnvironment('FIELDOPS_ENV', defaultValue: 'dev');

  /// Crash-free rate is per release; keep this in step with pubspec version.
  static const release = '2.4.0+24';

  /// Who this device reports as, for the Consumers view.
  static const technicianId = String.fromEnvironment(
    'TECHNICIAN_ID',
    defaultValue: 'tech-demo-01',
  );
}
