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
      path: packages/sentrinel_flutter_integration
```

## Use

```dart
void main() => SentrinelFlutter.run(
      options: SentrinelOptions(
        serverUrl: 'https://api.sentrinel.dev',
        appName: 'mobile-app',
        release: '1.4.2',
        apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
      ),
      app: () => runApp(const MyApp()),
    );
```

That one call replaces the boilerplate the core package documents: it starts a
guarded zone, initialises the core with a storage directory that survives a
restart, installs both error handlers, and begins tracking frames and app start.

`runApp` goes in the `app` callback rather than after the call, because
asynchronous errors are only caught inside the zone. Calling `runApp` outside it
would silently miss most of them.

Add the navigator observer for screen context:

```dart
MaterialApp(
  navigatorObservers: [SentrinelNavigatorObserver()],
)
```

## What this adds over the core

| | Why it cannot live in the core |
| --- | --- |
| `FlutterError.onError` | Flutter handles build/layout/paint errors itself; they never reach a zone |
| `PlatformDispatcher.onError` | Lives in `dart:ui` |
| App start to first frame | Needs `SchedulerBinding` |
| Slow and frozen frames | Needs `SchedulerBinding.addTimingsCallback` |
| Navigation breadcrumbs | Needs `NavigatorObserver` |
| Durable storage path | Needs `path_provider` |

Both error handlers are **chained, not replaced** — the red screen in debug, and
anything your app already installed, keep working.

### Frames

A slow frame missed the 16ms budget; a frozen frame took 700ms or more, at which
point the app has visibly stopped rather than merely stuttered. Reported as a
rolling summary once a minute — a 60fps app produces 3,600 frames a minute, and
shipping one record each would cost more battery and bandwidth than the insight
is worth.

Flush on backgrounding, where the next timer tick may never arrive:

```dart
AppLifecycleListener(onPause: SentrinelFlutter.onPause)
```

### App start

Measured from `SentrinelFlutter.init` to the first rendered frame, and reported
as `app.start_to_first_frame_ms` with `app.start_measured_from: sentrinel_init`.

It is deliberately **not** called cold start: it excludes process spawn and
engine boot, which on a slow device is most of what the user waited for. A
number that leaves out half the wait, under a name implying it does not, is
worse than no number.

## Still not covered

- **Native iOS/Android crashes and ANRs.** A segfault in a native library kills
  the process below Dart. That needs native crash handlers.
- **Symbolication.** Obfuscated release traces stay obfuscated; there is no
  upload for dSYMs, ProGuard mappings or Dart symbol files.

## Tests

```bash
flutter test
```

Real widget binding, because that is the only place this behaviour exists —
`FlutterError.onError` and the frame callbacks do not fire in a plain Dart test,
so asserting on them anywhere else would prove nothing.
