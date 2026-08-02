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

## Crash reporting

Uncaught Dart errors are captured automatically and **written to disk before the
process dies**, then sent on the next launch. That last part is what makes it
crash reporting rather than error reporting: the ordinary buffer flushes on a
30-second timer, and a crashing app never gets there.

```dart
void main() => Sentrinel.guard(() {
      Sentrinel.init(
        serverUrl: 'https://api.sentrinel.dev',
        appName: 'mobile-app',
        // Where reports wait between the crash and the next launch. Without a
        // real path this falls back to the system temp directory, which the OS
        // is free to clear — fine for development, not for shipping.
        storagePath: appSupportDir.path,
      );

      // Flutter handles its own errors before any zone sees them, so these two
      // lines are not optional. They live in your app because the types come
      // from package:flutter and dart:ui, which this package does not depend on
      // — that is what keeps it usable from plain Dart.
      FlutterError.onError =
          (d) => Sentrinel.flutterErrorHandler(d.exception, d.stack);
      PlatformDispatcher.instance.onError = (e, s) {
        Sentrinel.platformErrorHandler(e, s);
        return true;
      };

      runApp(const MyApp());
    });
```

What gets caught, and how it is labelled in `sentrinel.mechanism`:

| Source | Mechanism | Covered |
| --- | --- | --- |
| Async errors escaping to the zone | `runZonedGuarded` | ✅ via `guard()` |
| Flutter build/layout/paint errors | `FlutterError.onError` | ✅ with the wiring above |
| Errors reaching the engine | `PlatformDispatcher.onError` | ✅ with the wiring above |
| Errors on other isolates | `Isolate.onError` | ✅ automatic |
| Native iOS/Android crashes, ANRs | — | ❌ not covered |

Every report carries the OS, OS version, locale and core count, the session id,
and the last 25 breadcrumbs. HTTP requests leave breadcrumbs on their own; add
your own for navigation and taps:

```dart
Sentrinel.addBreadcrumb('opened checkout', category: 'navigation');
```

### Sessions

`init()` writes a session marker and `close()` removes it. A marker still there
on the next launch means the previous run never shut down cleanly, which is
reported as an `UnfinishedSession` error and exposed as
`Sentrinel.previousRunCrashed`.

That is the honest definition: a hard crash, a force-quit and an OS kill all
look identical from inside the next launch.

## What it will not do

- **Block your app.** Every call is buffered; nothing waits on the network.
- **Grow without bound.** Buffers cap at 500 requests / 500 logs / 200 errors,
  oldest dropped first, and `collector.droppedRecords` tells you how many.
- **Retry forever.** A batch that cannot be sent is dropped. On a device that
  may be offline for hours, stale telemetry is worth less than a working app.
- **Spam your console.** One warning per process if the server rejects a batch.
- **Crash when uninitialised.** Every call before `init()` is a no-op.
- **Catch native crashes.** A segfault in an iOS or Android library, or an ANR,
  kills the process below Dart and leaves nothing for this to report. That needs
  native crash handlers and a symbolication pipeline.
- **Symbolicate release stack traces.** An obfuscated Flutter release build
  produces traces this cannot un-obfuscate; upload of Dart symbol files, dSYMs
  and ProGuard mappings does not exist yet.

## Verify it end to end

```bash
dart run example/live_check.dart https://api.sentrinel.dev <your-api-key>
```

Sends three requests, an error, two logs and a captured exception, then exits.
They should appear in the dashboard within a few seconds.
