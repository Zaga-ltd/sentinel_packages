# Sentrinel for Android / JVM (Kotlin)

Crash reporting and release health for Android and the JVM. A pure Kotlin
library (no Android SDK or AndroidX dependency, so it also works in plain JVM
apps) that catches uncaught Kotlin/Java exceptions and posts the **same error
and session shapes** the Flutter SDK sends, so native crashes and Dart crashes
land in the same issues, sessions and release-health pages.

What it does **not** do (yet): tracing or `traceparent`, product events
(`track`), custom metrics, a `beforeSend` hook, native (JNI) signal crashes,
ANRs, or ProGuard mapping upload. See [Not covered](#not-covered).

## Install

From the public repo through [JitPack](https://jitpack.io), which builds the
`sentrinel_kotlin` directory (the repo's root `jitpack.yml` says how):

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}

// app/build.gradle.kts
dependencies {
    implementation("com.github.Zaga-ltd.sentinel_packages:sentrinel_kotlin:main-SNAPSHOT")
    // or pin a commit / tag: ...:sentrinel_kotlin:<commit-sha>
}
```

Without JitPack, clone the public repo and include the build — Gradle
substitutes the dependency with the source:

```kotlin
// settings.gradle.kts
includeBuild("../sentinel_packages/sentrinel_kotlin")

// app/build.gradle.kts
dependencies { implementation("dev.sentrinel:sentrinel_kotlin:0.2.0") }
```

## Start

```kotlin
import dev.sentrinel.Sentrinel

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Sentrinel.start(
            Sentrinel.Options(
                serverUrl = "https://api.sentrinel.dev",
                appName = "shop",           // the project — the same app your backend reports into
                env = "prod",
                apiKey = BuildConfig.SENTRINEL_API_KEY,   // a Mobile key
                module = "android",         // which part of it this is (default: the key's name)
                release = BuildConfig.VERSION_NAME,
            ),
            storageDirectory = filesDir,    // where crash reports survive a restart
        )
    }
}
```

**On Android pass `storageDirectory = filesDir`.** It survives restarts and needs
no permission. Without it the SDK falls back to `java.io.tmpdir` (the cache dir,
which the OS may clear); plain JVM apps can also set the `sentrinel.storage`
system property. `storagePath = null` in the options keeps everything in memory.

Call it first thing in `Application.onCreate()` (or `main()`), before any code
that could crash. Calling it again reconfigures; the crash handler is installed
once.

## Who the user is

Every install has a stable id (`Sentrinel.deviceId`). Until someone signs in,
errors and sessions are filed under `guest:<deviceId>` — one consumer per
install, no custom guest ids needed. Then:

```kotlin
Sentrinel.identify(user.id)   // after sign-in, at launch when a saved session
                              // is restored, and after profile updates
Sentrinel.identify(null)      // on sign-out: back to guest:<deviceId>
```

Every error carries `device.id`. To have your **own** backend's Sentrinel SDK
file server-side errors under the same person, add the identity headers to
requests to it (never to third parties):

```kotlin
// OkHttp interceptor, for your API's host only
chain.proceed(chain.request().newBuilder().apply {
    Sentrinel.identityHeaders().forEach { (name, value) -> header(name, value) }
}.build())
```

`consumerIdentifier` in the options (or `setConsumer`) pins a fixed value — a
tenant, a kiosk — until `identify` replaces it. Prefer `identify`.

## The app lifecycle

The OS kills backgrounded apps without notice. End the session when the app
leaves the foreground, so those kills are not reported as `abnormal`
(the library does not depend on AndroidX, so this is yours to wire):

```kotlin
ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
    override fun onStop(owner: LifecycleOwner) = Sentrinel.onBackground()   // ends the session, flushes
    override fun onStart(owner: LifecycleOwner) = Sentrinel.onForeground()  // same session within 30s
})
```

- **Backgrounding** → `onBackground()` (or just `flush()`). Not `close()`.
- **Termination** (JVM apps) → `Sentrinel.close()`: ends the session, waits up
  to 2 seconds for the final flush. Safe to call twice.

For tablets, tell it the form factor (needs a Context):

```kotlin
val tablet = resources.configuration.smallestScreenWidthDp >= 600
Sentrinel.setDeviceInfo(deviceType = if (tablet) "tablet" else "mobile")
```

## What gets captured

| Source | Mechanism | Reported as |
| --- | --- | --- |
| Uncaught Kotlin/Java exceptions, any thread | `Thread.setDefaultUncaughtExceptionHandler` | crash; session `crashed` |
| Handled exceptions | `Sentrinel.captureError` | error; session `errored` |
| Native signal crashes (SEGV, ABRT, …), ANRs | — | ❌ needs JNI |

An uncaught exception is written to disk (fsync'd) before the handler returns,
and also posted immediately — the handler waits up to 1.5 s for it. Its disk
copy is removed only when the server acknowledges it; otherwise the next launch
sends it, and a replay that fails is kept and retried. The previous handler
(Android's crash dialog and process kill) always runs afterwards, even if
writing the report fails.

On Android the OS version and model come from `android.os.Build` (read by
reflection), not the JVM's `os.name`, which reports "linux" and the kernel.

```kotlin
try {
    doSomething()
} catch (e: Exception) {
    Sentrinel.captureError(e, path = "checkout")
}

Sentrinel.addBreadcrumb("tapped pay", category = "ui", data = mapOf("amount" to 42))
Sentrinel.setContext(mapOf("screen" to "checkout", "tier" to "pro"))
```

## Sessions

| Status | Meaning |
| --- | --- |
| `ok` | Running, or ended cleanly |
| `errored` | Survived, but reported an error |
| `crashed` | A fatal error was written before the process died |
| `abnormal` | Ended without a clean shutdown *and* without a crash report |

## Wire contract

- `POST {serverUrl}/api/ingest/errors` — `{ appName, env, module?, sdk, errors: [...] }`
- `POST {serverUrl}/api/ingest/sessions` — `{ appName, env, module?, sdk, sessions: [...] }`

Every post sends `User-Agent: sentrinel.kotlin/<version> (Android 14; Mobile)`
and `sdk: { name, version }`. `NaN` and `±Infinity` attribute values are sent as
`null`.

## Build and test

```bash
cd packages/sentrinel_kotlin
./gradlew build
```

The wrapper pins Gradle 8.10.2 and the toolchain resolver fetches a JDK 11 if
needed. (Run the wrapper under JDK 17 — Homebrew's newest JDK crashes the
Kotlin compiler.) The tests read what the SDK posts back off a real socket.

## Not covered

- **Native signal crashes and ANRs.** ART delivers SIGSEGV/SIGABRT to the native
  layer, which pure Kotlin cannot intercept — that needs a JNI handler.
- **Symbolication.** No ProGuard/R8 mapping upload yet.
- **Tracing, events, metrics, `beforeSend`.** Not in this SDK.
