# sentrinel_flutter

The Flutter half of Sentrinel. The pure-Dart [`sentrinel`](../sentrinel_flutter)
package does the collecting; this does the parts that need the framework.

Two packages rather than one because the core is also used from CLIs and
server-side Dart. Adding a `flutter` dependency to it would end that.

## Install

```yaml
dependencies:
  sentrinel_flutter:
    git:
      url: https://github.com/Zaga-ltd/sentinel_packages
      path: sentrinel_flutter_integration
```

## Use

```dart
void main() => SentrinelFlutter.run(
      options: SentrinelOptions(
        serverUrl: 'https://api.sentrinel.dev',
        appName: 'mobile-app',
        release: '1.4.2',
        apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
        // Your own backends: they get traceparent and the consumer/device
        // headers. Third parties get nothing.
        tracePropagationTargets: ['api.example.com'],
      ),
      app: () => runApp(const MyApp()),
    );
```

That one call replaces the boilerplate the core package documents: it starts a
guarded zone, initialises the core with a storage directory that survives a
restart, installs both error handlers, ends the session and flushes when the
app is backgrounded, reports phone vs tablet, and tracks frames and app start.
Calling it (or `SentrinelFlutter.init`) again reconfigures without stacking
handlers or observers.

`runApp` goes in the `app` callback rather than after the call, because
asynchronous errors are only caught inside the zone. Calling `runApp` outside it
would silently miss most of them.

Then tell Sentrinel who the user is — after sign-in, at launch when a saved
session is restored, and after profile updates; `null` on sign-out:

```dart
Sentrinel.identify(user.id);
Sentrinel.identify(null);
```

Signed-out traffic is filed under `guest:<install id>`, one consumer per
install; no custom guest ids needed.

Add the navigator observer for screen context:

```dart
MaterialApp(
  navigatorObservers: [SentrinelNavigatorObserver()],
)
```

Optional, for model and Android version (needs `device_info_plus`):

```dart
final info = await DeviceInfoPlugin().androidInfo;
Sentrinel.setDeviceInfo(model: info.model, osVersion: info.version.release);
```

## What this adds over the core

| | Why it cannot live in the core |
| --- | --- |
| `FlutterError.onError` | Flutter handles build/layout/paint errors itself; they never reach a zone |
| `PlatformDispatcher.onError` | Lives in `dart:ui` |
| Session end + flush on background | Needs `WidgetsBindingObserver` |
| Phone vs tablet | Needs the view's size |
| App start to first frame | Needs `SchedulerBinding` |
| Slow and frozen frames | Needs `SchedulerBinding.addTimingsCallback` |
| Navigation breadcrumbs | Needs `NavigatorObserver` |
| Durable storage path | Needs `path_provider` |

Both error handlers are **chained, not replaced** — the red screen in debug, and
anything your app already installed, keep working. Errors they catch are
reported as **unhandled**, not as crashes: after an overflow, a failed image or
a throwing build method Flutter shows an error widget and the app carries on.
They mark the session `errored` and are sent within about a second. Errors
Flutter marks `silent` are skipped.

### The lifecycle

When the app goes to `hidden`, `paused` or `detached`, the session is ended with
its duration, the frame window is reported and everything is flushed. The OS
may kill a backgrounded app without notice; ending the session first is what
keeps that from being reported as `abnormal` on the next launch. Back within 30
seconds it is the same session; after that, a new one. Set
`trackLifecycle: false` to drive `SentrinelFlutter.onPause` / `onResume`
yourself.

### Frames

A slow frame missed the display's budget — 16.7ms at 60Hz, 8.3ms at 120Hz, read
from `PlatformDispatcher.displays` (16ms when it cannot be read); a frozen frame
took 700ms or more, at which point the app has visibly stopped rather than
merely stuttered. Reported as a rolling summary once a minute — a 60fps app
produces 3,600 frames a minute, and shipping one record each would cost more
battery and bandwidth than the insight is worth.

### App start

Measured from `SentrinelFlutter.init` to the first rendered frame, and reported
as `app.start_to_first_frame_ms` with `app.start_measured_from: sentrinel_init`.

It is deliberately **not** called cold start: it excludes process spawn and
engine boot, which on a slow device is most of what the user waited for. A
number that leaves out half the wait, under a name implying it does not, is
worse than no number.

## Still not covered

- **Native iOS/Android crashes and ANRs.** A segfault in a native library kills
  the process below Dart. That needs native crash handlers — the Swift and
  Kotlin SDKs cover native apps, not Flutter's host process.
- **Symbolication.** Obfuscated release traces stay obfuscated; there is no
  upload for dSYMs, ProGuard mappings or Dart symbol files.

## Tests

```bash
flutter test
```

Real widget binding, because that is the only place this behaviour exists —
`FlutterError.onError`, lifecycle changes and frame callbacks do not fire in a
plain Dart test, so asserting on them anywhere else would prove nothing.
