# sentrinel — Flutter & Dart

Records every request your app makes, every error it hits, and the logs around
them — and sends `traceparent` so the backend continues the *same* trace. A tap
and the server work it caused land on one timeline.

## Install

Not on pub.dev. Add it from the public repo:

```yaml
dependencies:
  sentrinel:
    git:
      url: https://github.com/Zaga-ltd/sentinel_packages.git
      path: sentrinel_flutter
```

## Use

```dart
import 'package:sentrinel/sentrinel.dart';

void main() {
  Sentrinel.init(
    serverUrl: 'https://api.sentrinel.dev',
    appName: 'mobile-app',
    env: 'prod',
    apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
    consumerIdentifier: 'ios_app',
  );
  runApp(const MyApp());
}
```

Then send through the wrapped client and every call is recorded:

```dart
final client = Sentrinel.httpClient();          // or: httpClient(inner: myClient)
await client.get(Uri.parse('https://api.example.com/v1/orders'));
```

### Context

Set it once where you know it; it rides on every later record.

```dart
Sentrinel.setContext({'screen': 'checkout', 'tier': user.tier});
```

### Logs and errors

```dart
Sentrinel.info('Checkout opened', category: 'ui', attributes: {'items': 3});
Sentrinel.warn('Slow image', category: 'ui', attributes: {'ms': 1840});

try {
  await pay();
} catch (e, s) {
  Sentrinel.captureError(e, s, path: 'checkout');
}
```

For crashes, hand it your zone handler:

```dart
runZonedGuarded(
  () => runApp(const MyApp()),
  (e, s) => Sentrinel.captureError(e, s),
);
```

### Flushing

Batches go out every 30s by default. A backgrounded app may not get another
tick, so flush when you lose the foreground:

```dart
if (state == AppLifecycleState.paused) Sentrinel.flush();
```

## What it will not do

- **Block your app.** Every call is buffered; nothing waits on the network.
- **Grow without bound.** Buffers cap at 500 requests / 500 logs / 200 errors,
  oldest dropped first, and `collector.droppedRecords` tells you how many.
- **Retry forever.** A batch that cannot be sent is dropped. On a device that
  may be offline for hours, stale telemetry is worth less than a working app.
- **Spam your console.** One warning per process if the server rejects a batch.
- **Crash when uninitialised.** Every call before `init()` is a no-op.

## Verify it end to end

```bash
dart run example/live_check.dart https://api.sentrinel.dev <your-api-key>
```

Sends three requests, an error, two logs and a captured exception, then exits.
They should appear in the dashboard within a few seconds.
