# sentrinel — Flutter & Dart

Records every request your app makes, every error it hits, and the logs around
them — and sends `traceparent` to your own backends so they continue the *same*
trace. A tap and the server work it caused land on one timeline.

On Flutter, use [`sentrinel_flutter`](../sentrinel_flutter_integration) — it
wires everything below for you. This package is the pure-Dart core, also usable
from CLIs and server-side Dart.

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

void main() => Sentrinel.guard(() {
      Sentrinel.init(
        serverUrl: 'https://api.sentrinel.dev',
        appName: 'mobile-app',
        env: 'prod',
        // A Mobile app key: it ships in the bundle, so it is issued to send only
        // what a phone sends — a leaked one cannot post a replay or read anything.
        apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
        release: '1.4.2',
        // Your own backends. Only these receive traceparent and the
        // x-sentrinel-consumer / x-sentrinel-device headers.
        tracePropagationTargets: ['api.example.com'],
      );
      runApp(const MyApp());
    });
```

Then send through the wrapped client and every call is recorded:

```dart
final client = Sentrinel.httpClient();          // or: httpClient(inner: myClient)
await client.get(Uri.parse('https://api.example.com/v1/orders'));
```

Using Dio? Route it through the same client with the Dio team's
[`dio_compatibility_layer`](https://pub.dev/packages/dio_compatibility_layer):

```dart
final dio = Dio()..httpClientAdapter = ConversionLayerAdapter(Sentrinel.httpClient());
```

### Who the traffic belongs to

Every install has a stable id (`Sentrinel.deviceId`). Until someone signs in,
requests, errors and logs are filed under `guest:<deviceId>` — each install its
own consumer. Tell Sentrinel who the user is:

```dart
Sentrinel.identify(user.id);   // after sign-in
                               // at launch, when a saved session is restored
                               // after the profile changes
Sentrinel.identify(null);      // on sign-out — back to guest:<deviceId>
```

No custom guest ids needed. Every record also carries `device.id`, and the
wrapped client sends `x-sentrinel-consumer` and `x-sentrinel-device` to your
propagation targets, so the backend SDKs file server-side errors under the same
person. `consumerIdentifier` at init (or `setConsumer`) pins a fixed value — a
tenant, a kiosk — until `identify` replaces it; prefer `identify`.

### The device

`dart:io` knows the OS (and the iOS version). Feed the rest from
`device_info_plus` so the dashboard can split by model and version:

```dart
final info = await DeviceInfoPlugin().androidInfo;
Sentrinel.setDeviceInfo(model: info.model, osVersion: info.version.release);
```

`sentrinel_flutter` sets phone vs tablet from the screen on its own.

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

Attribute values can be anything: a `DateTime` is sent as ISO-8601, `NaN` as
null, an enum by name, anything else by `toJson()` or `toString()`.

### Filtering: `beforeSend`

```dart
Sentrinel.init(
  // …
  beforeSend: (kind, record) {
    // kind: request · error · log · span · event
    if (kind == 'log' && record['category'] == 'debug') return null; // drop
    return record;                                                   // or rewrite
  },
);
```

Runs before a crash report is written to disk, so what it removes is never
stored either. A hook that throws drops the record.

Query strings, fragments and userinfo are stripped from URLs in span
attributes and transport-error messages by default.

### Flushing and the lifecycle

Batches go out every 30s by default. A backgrounded app may never get another
tick, so tell Sentrinel when it leaves and returns (`sentrinel_flutter` does
this for you):

```dart
Sentrinel.onBackground(); // ends the session with its duration, flushes
Sentrinel.onForeground(); // same session within 30s, a new one after
```

## Errors and crashes

| Source | Mechanism | Reported as |
| --- | --- | --- |
| Async errors escaping to the zone | `runZonedGuarded` via `guard()` | unhandled; session `errored` |
| Flutter build/layout/paint errors | `FlutterError.onError` | unhandled; session `errored` (`silent` ones skipped) |
| Errors reaching the engine | `PlatformDispatcher.onError` | unhandled; session `errored` |
| Errors on spawned isolates | `Isolate.onError` | unhandled; session `errored` |
| `captureError(e, s, fatal: true)` | your call | crash: written to disk, session `crashed` |
| Native iOS/Android crashes, ANRs | — | ❌ not covered |

Unhandled errors are sent within about a second — a Flutter app keeps running
after them, so they are not counted as crashes.

A **fatal** error is the app saying it is about to die. It is written to disk
**before `captureError` returns**, and also sent immediately; its disk copy is
removed once the server acknowledges it, so it is never delivered twice. If the
process dies first, the next launch sends it. A replay that fails (offline) is
kept and retried on the next flush and the next launch — never deleted merely
because it was read. The queue is bounded: 50 records / 256 KB per run.

Where there is no disk — Flutter web, or `persistCrashes: false` — a fatal error
goes straight to the network.

Every report carries the OS, OS version, locale and core count, the install id,
the session id, and the last 25 breadcrumbs. HTTP requests leave breadcrumbs on
their own; add your own for navigation and taps:

```dart
Sentrinel.addBreadcrumb('opened checkout', category: 'navigation');
```

### Sessions

`init()` starts a session and writes a marker; `close()` and `onBackground()`
end it and remove the marker. A marker still there on the next launch means the
previous run never shut down cleanly: it is reported as a session with status
`crashed` (a fatal error was recorded) or `abnormal` (killed without one), and
`Sentrinel.previousRunCrashed` is true.

That is the honest definition: a hard crash, a force-quit and an OS kill of a
foreground app all look identical from inside the next launch. Sessions only get
worse: `ok` → `errored` → `abnormal` / `crashed`.

## What it will not do

- **Block your app.** Every call is buffered; nothing waits on the network.
- **Grow without bound.** Buffers cap at 500 requests / 500 logs / 500 spans /
  200 errors, oldest dropped first, and `collector.droppedRecords` tells you how
  many.
- **Flood the radio.** At most four posts in flight; spans go in one batch.
- **Retry forever.** A live batch that cannot be sent is dropped. Only crash
  reports, which are also on disk, are retried.
- **Talk to third parties.** No `traceparent` or identity headers except to
  `tracePropagationTargets` (and same-origin on web).
- **Close your client.** An `httpClient` you pass in is yours.
- **Spam your console.** One warning per process if the server rejects a batch.
- **Crash when uninitialised.** Every call before `init()` is a no-op.
- **Catch native crashes.** A segfault in an iOS or Android library, or an ANR,
  kills the process below Dart and leaves nothing for this to report.
- **Symbolicate release stack traces.** Upload of Dart symbol files, dSYMs and
  ProGuard mappings does not exist yet.

## Verify it end to end

```bash
dart run example/live_check.dart https://api.sentrinel.dev <your-api-key>
```

Sends three requests, an error, two logs and a captured exception, then exits.
They should appear in the dashboard within a few seconds.
