# Sentrinel for iOS / macOS (Swift)

Native crash reporting and release health. A Swift package that catches what
the Flutter/Dart SDK cannot — a segfault, a Swift trap, an ObjC exception — and
posts the **same error and session shapes** the Flutter SDK sends, so native
crashes and Dart crashes land in the same issues, sessions and release-health
pages.

What it does **not** do (yet): tracing or `traceparent`, product events
(`track`), custom metrics, a `beforeSend` hook, or dSYM upload. Those are in the
Flutter/Dart SDK or [not covered](#not-covered).

## Install

Swift Package Manager, from the public repo (its root `Package.swift` declares
this package):

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/Zaga-ltd/sentinel_packages.git", branch: "main"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "Sentrinel", package: "sentinel_packages"),
    ]),
]
```

In Xcode: **File → Add Package Dependencies…**, paste the URL, add the
`Sentrinel` library to your app target.

## Start

```swift
import Sentrinel

Sentrinel.start(options: .init(
    serverUrl: URL(string: "https://api.sentrinel.dev")!,
    appName: "shop",          // the project — the same app your backend reports into
    env: "prod",
    apiKey: "<a Mobile key>",
    module: "ios",            // which part of it this is (default: the key's name)
    release: "1.4.2"
))
```

Call it early — in `application(_:didFinishLaunchingWithOptions:)` or your
`@main` initializer, before any code that could crash. `storagePath` defaults to
Application Support.

An app in Sentrinel is the whole project. The phone reports into the same app
as the backend, as a module of it.

## Who the user is

Every install has a stable id (`Sentrinel.deviceId`). Until someone signs in,
errors and sessions are filed under `guest:<deviceId>` — one consumer per
install, no custom guest ids needed. Then:

```swift
Sentrinel.identify(user.id)   // after sign-in, at launch when a saved session
                              // is restored, and after profile updates
Sentrinel.identify(nil)       // on sign-out: back to guest:<deviceId>
```

Every error carries `device.id`. To have your **own** backend's Sentrinel SDK
file server-side errors under the same person, add the identity headers to
requests to it (never to third parties):

```swift
for (name, value) in Sentrinel.identityHeaders {
    request.setValue(value, forHTTPHeaderField: name)
}
```

`consumerIdentifier` in the options (or `setConsumer`) pins a fixed value — a
tenant, a kiosk — until `identify` replaces it. Prefer `identify`.

## What gets captured

| Source | Mechanism | Reported as |
| --- | --- | --- |
| Uncaught ObjC exceptions | `NSSetUncaughtExceptionHandler` | crash, with name, reason and symbols |
| Swift traps (force-unwrap, bounds, `fatalError`) | `sigaction` SIGTRAP | crash |
| Fatal signals: ABRT, BUS, FPE, ILL, SEGV | `sigaction` | crash, with return addresses |
| Handled errors | `Sentrinel.captureError` | error; session `errored` |

A crash is written to disk as it happens and delivered on the next launch. The
signal handler is async-signal-safe: the record is pre-rendered while the app
runs, and at crash time the handler only adds the time, the signal name and the
return addresses and calls `write(2)` on a descriptor opened at start. It runs
on an alternate stack (for the thread that called `start`), then hands the
signal to whatever handler was installed before — the system crash report and
other reporters still see it. An NSException and the `abort()` it ends in are
reported once.

Signal reports carry raw return addresses plus the main image's load address
(`sentrinel.image_base`); symbolicating them needs the dSYM, which is not
uploaded yet.

A crash report leaves the disk only after the server acknowledges it. A replay
that fails (offline) is retried on the next flush and on the next launch.

```swift
do {
    try something()
} catch {
    Sentrinel.captureError(error, path: "checkout")
}

Sentrinel.addBreadcrumb("tapped pay", category: "ui", data: ["amount": 42])
Sentrinel.setContext(["screen": "checkout", "tier": "pro"])
```

Attribute values that JSON cannot hold (`NaN`, `±Infinity`) are sent as `null`
rather than failing the batch.

## Sessions and the app lifecycle

One session per foreground stretch is the denominator crash-free rate needs.

| Status | Meaning |
| --- | --- |
| `ok` | Running, or ended cleanly |
| `errored` | Survived, but reported an error |
| `crashed` | A fatal error was written before the process died |
| `abnormal` | Ended without a clean shutdown *and* without a crash report |

On iOS this is automatic: when the app enters the background the session ends
with its duration and everything is flushed (held open with
`performExpiringActivity`, which also works in extensions); back within 30
seconds it is the same session, after that a new one. That is what keeps the
OS killing a backgrounded app from being reported as `abnormal`. On termination
the SDK closes itself.

Doing it by hand (`trackLifecycle: false`, or macOS):

- **Backgrounding** → `Sentrinel.flush()` (or `didEnterBackground()` /
  `willEnterForeground()` to end and resume the session). Do **not** call
  `close()` here — it shuts the SDK down for the rest of the process.
- **Termination** → `Sentrinel.close()`. Waits up to 2 seconds for the final
  flush; safe to call twice.

## Wire contract

- `POST {serverUrl}/api/ingest/errors` — `{ appName, env, module?, sdk, errors: [...] }`
- `POST {serverUrl}/api/ingest/sessions` — `{ appName, env, module?, sdk, sessions: [...] }`

Every post sends `User-Agent: sentrinel.swift/<version> (iOS 17.4; iPhone)` and
`sdk: { name, version }`.

## Tests

```bash
cd packages/sentrinel_swift
swift test
```

## Not covered

- **Symbolication.** Release builds report addresses; there is no dSYM upload
  yet.
- **Tracing, events, metrics, `beforeSend`.** Not in this SDK.
- **Stack overflow on a secondary thread.** `sigaltstack` is per thread; only
  the thread that called `start` has the alternate stack.
- **Watchdog terminations and OOM kills.** No signal reaches the process; they
  show up as `abnormal` sessions.
