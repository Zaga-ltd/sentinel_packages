package dev.sentrinel

import java.io.File
import java.util.UUID

/**
 * Sentrinel for Android / JVM.
 *
 * Crash reporting and release health. Posts the same error and session shapes
 * the Flutter SDK sends, so native crashes and Dart crashes land in the same
 * issues, sessions and release-health pages.
 *
 * ```kotlin
 * // Application.onCreate()
 * Sentrinel.start(
 *     Sentrinel.Options(
 *         serverUrl = "https://api.sentrinel.dev",
 *         appName = "mobile-app",
 *         env = "prod",
 *         apiKey = BuildConfig.SENTRINEL_API_KEY,
 *         release = BuildConfig.VERSION_NAME,
 *     ),
 *     storageDirectory = filesDir,   // Android: survives restarts
 * )
 * Sentrinel.identify(user.id)        // after sign-in; null on sign-out
 * ```
 *
 * After `start`, uncaught exceptions on any thread are written to disk before
 * the process dies and delivered on the next launch. `captureError` reports
 * handled errors; `addBreadcrumb` leaves a trail.
 *
 * What this SDK does not do (yet): tracing, `traceparent`, product events,
 * custom metrics, or a `beforeSend` hook. Those are in the Flutter/Dart SDK.
 */
object Sentrinel {
    private val lock = Any()
    @Volatile private var collector: Collector? = null
    @Volatile private var spool: CrashSpool? = null
    @Volatile private var persistCrashes = false
    @Volatile private var consumerOverride: String? = null
    @Volatile private var userId: String? = null
    @Volatile private var installId: String? = null
    @Volatile private var facts: DeviceFacts = Device.facts()
    @Volatile private var factsOverride = DeviceFacts(null, null, null, null, false)
    @Volatile private var device: Map<String, Any?> = emptyMap()
    @Volatile private var context: Map<String, Any?> = emptyMap()
    private val crumbs = BreadcrumbTrail()
    @Volatile private var appName = ""
    @Volatile private var env = "prod"
    @Volatile private var release: String? = null
    @Volatile private var sessionId: String? = null
    @Volatile private var sessionStartedAt: Long = 0
    @Volatile private var sessionStatus = "ok"
    @Volatile private var backgroundedAt: Long = 0

    /** How long the app may sit in the background and still be the same
     * session when it returns. Past it, returning starts a new one. */
    @Volatile var sessionTimeoutMs: Long = 30_000

    /** True once [start] has been called. Every other call is a no-op until
     * then, so a missing init degrades to "no telemetry" rather than a crash. */
    val isStarted: Boolean get() = collector != null

    /** Set when the previous run ended without a clean shutdown. */
    @Volatile
    var previousRunCrashed: Boolean = false
        private set

    data class Options(
        val serverUrl: String,
        val appName: String,
        val env: String = "prod",
        val apiKey: String? = null,
        /** Which part of the project this is — "mobile", "tv". An app is the
         * whole project; the phone reports as a module of it beside the backend.
         * Null uses the API key's name. */
        val module: String? = null,
        /** The build this is — a version name, a git SHA. Crash-free rate is
         * per release; without it every build is "unknown". */
        val release: String? = null,
        val flushIntervalMs: Long = 30_000,
        /** Pins the consumer to a fixed value — a tenant, a kiosk — until
         * [identify] replaces it. Usually leave it null: signed-out traffic is
         * `guest:<install id>`, and `identify(user.id)` names the person. */
        val consumerIdentifier: String? = null,
        /** Where crash reports and the install id live between launches. On
         * Android use the `start(options, storageDirectory = filesDir)`
         * overload. Defaults to the `sentrinel.storage` system property, else
         * `<java.io.tmpdir>/sentrinel` (on Android that is the app's cache dir,
         * which the OS may clear). Null keeps everything in memory. */
        val storagePath: File? = defaultStoragePath(),
        /** Write fatal errors to disk so they survive the process. Off (or with
         * no storage), a fatal error is sent straight away instead. */
        val persistCrashes: Boolean = true,
        /** Install the uncaught-exception handler. */
        val installCrashHandler: Boolean = true,
    )

    /** `sentrinel.storage` if set, else `<java.io.tmpdir>/sentrinel`. */
    fun defaultStoragePath(): File? =
        System.getProperty("sentrinel.storage")?.let { File(it) }
            ?: System.getProperty("java.io.tmpdir")?.let { File(it, "sentrinel") }

    /**
     * Start with crash reports and the install id kept under
     * [storageDirectory] — on Android pass `context.filesDir`, which survives
     * restarts and needs no permission. Without a directory an Android app
     * persisted nothing: `sentrinel.storage` is never set there.
     */
    fun start(options: Options, storageDirectory: File) {
        start(options.copy(storagePath = File(storageDirectory, "sentrinel")))
    }

    fun start(options: Options) {
        synchronized(lock) {
            // Starting again replaces the collector. The old one's buffer is
            // sent and its session closed cleanly, not reported as abnormal by
            // the new one.
            collector?.let { old ->
                endSession(old)
                old.stop(timeoutMs = 0)
            }

            consumerOverride = options.consumerIdentifier?.trim()?.takeIf { it.isNotEmpty() }
            userId = null
            facts = mergeFacts()
            device = Device.context(facts)
            release = options.release
            appName = options.appName
            env = options.env
            crumbs.clear()
            persistCrashes = options.persistCrashes && options.storagePath != null
            backgroundedAt = 0

            val spool = options.storagePath?.let { CrashSpool(it) }
            this.spool = spool
            installId = resolveInstallId(spool)

            val collector = Collector(
                serverUrl = options.serverUrl,
                appName = options.appName,
                env = options.env,
                apiKey = options.apiKey,
                module = options.module,
                flushIntervalMs = options.flushIntervalMs,
                userAgent = Device.userAgent(facts),
            )
            collector.onDelivered = { ids -> spool?.acknowledge(ids) }
            this.collector = collector

            val replay = if (persistCrashes && spool != null) spool.drain() else emptyList()
            openSession(collector, replay)
            for (record in replay) {
                // Replayed as-is: serialised at crash time, timestamps from then.
                collector.recordRaw(record.kind, record.json, record.id)
            }
            collector.start()
            if (replay.isNotEmpty()) collector.flush()

            if (options.installCrashHandler) {
                CrashHandler.writer = { _, throwable -> writeUncaught(throwable) }
                CrashHandler.install()
            }
        }
    }

    // ─── Identity ────────────────────────────────────────────────────────────

    /** This install's id: the same across launches, different on every device.
     * Every error carries it as `device.id`, and it is the `guest:` consumer
     * while nobody is signed in. */
    val deviceId: String? get() = installId

    /** Who errors and sessions are filed under: the signed-in user after
     * [identify], `guest:<install id>` before it, or a pinned value. */
    val consumer: String?
        get() = consumerOverride ?: userId ?: installId?.let { "guest:$it" }

    /**
     * Attach a real identity to everything from here on.
     *
     * Call it after sign-in, at launch when a saved session is restored, and
     * after profile updates. `null` signs them out: traffic returns to
     * `guest:<install id>`. It also clears a consumer pinned with
     * [setConsumer] or `consumerIdentifier`.
     */
    fun identify(userId: String?) {
        this.userId = userId?.trim()?.takeIf { it.isNotEmpty() }
        consumerOverride = null
    }

    /** Pin the consumer to something that is not the signed-in user — a
     * tenant, a kiosk. `null` un-pins it. */
    fun setConsumer(identifier: String?) {
        consumerOverride = identifier?.trim()?.takeIf { it.isNotEmpty() }
    }

    @Deprecated("Use identify", ReplaceWith("identify(id)"))
    fun setUser(id: String?) = identify(id)

    /**
     * Headers for requests to **your own** backend, so its Sentrinel SDK files
     * server-side errors under the same person and install. Never add them to
     * third-party requests.
     *
     * ```kotlin
     * // OkHttp
     * val request = original.newBuilder().apply {
     *     Sentrinel.identityHeaders().forEach { (name, value) -> header(name, value) }
     * }.build()
     * ```
     */
    fun identityHeaders(): Map<String, String> = buildMap {
        consumer?.let { put("x-sentrinel-consumer", it) }
        installId?.let { put("x-sentrinel-device", it) }
    }

    /**
     * Tell Sentrinel what reflection cannot see. A tablet needs a Context to
     * tell apart:
     *
     * ```kotlin
     * val tablet = resources.configuration.smallestScreenWidthDp >= 600
     * Sentrinel.setDeviceInfo(deviceType = if (tablet) "tablet" else "mobile")
     * ```
     */
    fun setDeviceInfo(model: String? = null, osVersion: String? = null, deviceType: String? = null) {
        synchronized(lock) {
            val o = factsOverride
            factsOverride = o.copy(
                model = model ?: o.model,
                osVersion = osVersion ?: o.osVersion,
                deviceType = deviceType ?: o.deviceType,
            )
            facts = mergeFacts()
            device = Device.context(facts)
            collector?.userAgent = Device.userAgent(facts)
        }
    }

    private fun mergeFacts(): DeviceFacts {
        val base = Device.facts()
        val o = factsOverride
        return base.copy(
            model = o.model ?: base.model,
            osVersion = o.osVersion ?: base.osVersion,
            deviceType = o.deviceType ?: base.deviceType,
        )
    }

    private fun resolveInstallId(spool: CrashSpool?): String {
        spool?.readInstallId()?.let { return it }
        val fresh = UUID.randomUUID().toString().replace("-", "")
        spool?.writeInstallId(fresh)
        return fresh
    }

    // ─── Recording ───────────────────────────────────────────────────────────

    /** Report an error. Non-fatal by default: sent on the next flush and the
     * session marked `errored`. `fatal = true` means the process is about to
     * die — written to disk before this returns, sent now too, session marked
     * `crashed`. */
    fun captureError(
        throwable: Throwable,
        path: String = "app",
        attributes: Map<String, Any?>? = null,
        fatal: Boolean = false,
        mechanism: String? = null,
    ) {
        capture(throwable, path, attributes, fatal, mechanism)
    }

    /** Leave a marker describing something the app just did. Attached to every
     * error reported afterwards. Safe from any thread. */
    fun addBreadcrumb(message: String, category: String = "app", data: Map<String, Any?>? = null) {
        crumbs.add(Breadcrumb(timestamp = System.currentTimeMillis(), category = category, message = message, data = data))
    }

    /** Fields attached to every subsequent record — screen, user tier, build. */
    fun setContext(fields: Map<String, Any?>) {
        synchronized(lock) { context = context + fields }
    }

    /** Send whatever is buffered now, in the background. The call for
     * backgrounding — it does not end anything. */
    fun flush() {
        collector?.flush()
    }

    /**
     * The app went to the background: end the session with its duration and
     * flush. The OS kills backgrounded apps without notice; ending first is
     * what keeps that from being reported as `abnormal` on the next launch.
     *
     * The library has no AndroidX dependency, so wire it yourself:
     *
     * ```kotlin
     * ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
     *     override fun onStop(owner: LifecycleOwner) = Sentrinel.onBackground()
     *     override fun onStart(owner: LifecycleOwner) = Sentrinel.onForeground()
     * })
     * ```
     */
    fun onBackground() {
        val collector = synchronized(lock) {
            val c = collector ?: return
            if (backgroundedAt != 0L) return
            backgroundedAt = System.currentTimeMillis()
            endSession(c)
            c
        }
        collector.flush()
    }

    /** The app came back: the same session within [sessionTimeoutMs], a new one
     * after. */
    fun onForeground() {
        synchronized(lock) {
            val since = backgroundedAt
            val c = collector ?: return
            if (since == 0L) return
            backgroundedAt = 0
            if (System.currentTimeMillis() - since >= sessionTimeoutMs) {
                openSession(c, emptyList())
            } else if (persistCrashes) {
                spool?.resumeSession(marker())
            }
        }
    }

    /** Shut down for good — process termination, not backgrounding. Ends the
     * session cleanly and waits up to [timeoutMs] for the final flush. Safe to
     * call twice; every call after the first is a no-op. */
    fun close(timeoutMs: Long = 2_000) {
        val collector = synchronized(lock) {
            val c = collector ?: return
            this.collector = null
            if (backgroundedAt == 0L) endSession(c)
            sessionId = null
            sessionStartedAt = 0
            c
        }
        collector.stop(timeoutMs)
    }

    /** Test seam: the process dies. No session end, no final flush; the marker
     * and the spool are left exactly as they are. */
    internal fun abandonForTesting() {
        val c = synchronized(lock) {
            val c = collector
            collector = null
            sessionId = null
            c
        }
        c?.abandon()
    }

    // ─── Sessions ────────────────────────────────────────────────────────────

    private fun marker(): Map<String, Any?> = linkedMapOf<String, Any?>(
        "sessionId" to sessionId,
        "startedAt" to iso8601(sessionStartedAt),
        "appName" to appName,
        "env" to env,
        "crashed" to (sessionStatus == "crashed"),
    ).apply {
        release?.let { put("release", it) }
        consumer?.let { put("distinctId", it) }
    }

    private fun sessionRecord(durationMs: Double? = null): SessionRecord? {
        val id = sessionId ?: return null
        return SessionRecord(
            sessionId = id,
            status = sessionStatus,
            startedAt = sessionStartedAt,
            release = release,
            distinctId = consumer,
            deviceOs = facts.os,
            deviceOsVersion = facts.osVersion,
            durationMs = durationMs,
        )
    }

    /** Record that this run started, and notice if the last one never finished. */
    private fun openSession(collector: Collector, replay: List<SpooledRecord>) {
        sessionId = UUID.randomUUID().toString().replace("-", "")
        sessionStartedAt = System.currentTimeMillis()
        sessionStatus = "ok"
        val previous = if (persistCrashes) spool?.beginSession(marker()) else null
        sessionRecord()?.let { collector.recordSession(it) }

        previousRunCrashed = previous != null
        val prev = previous ?: return

        // The previous session left its marker, so it did not shut down
        // cleanly. With a crash report it is `crashed`; without, `abnormal`.
        val previousId = prev["sessionId"] as? String
        val crashed = prev["crashed"] == true || replay.any { record ->
            val attrs = record.json["attributes"] as? Map<*, *>
            attrs?.get("sentrinel.fatal") == true && previousId != null && attrs["session.id"] == previousId
        }
        collector.recordSession(
            SessionRecord(
                sessionId = previousId?.takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString().replace("-", ""),
                status = if (crashed) "crashed" else "abnormal",
                startedAt = parseIso8601(prev["startedAt"] as? String) ?: System.currentTimeMillis(),
                release = prev["release"] as? String,
                // The owner the marker recorded, or none — the server keeps the
                // one it has. Not whoever launched the app this time.
                distinctId = prev["distinctId"] as? String,
                deviceOs = facts.os,
                deviceOsVersion = facts.osVersion,
            )
        )
    }

    private fun endSession(collector: Collector) {
        if (sessionId == null || sessionStartedAt == 0L) return
        sessionRecord((System.currentTimeMillis() - sessionStartedAt).toDouble())?.let { collector.recordSession(it) }
        if (persistCrashes) spool?.endSession()
    }

    private fun worsenSession(collector: Collector, status: String) {
        val rank = mapOf("ok" to 0, "errored" to 1, "crashed" to 3)
        if ((rank[status] ?: 0) <= (rank[sessionStatus] ?: 0)) return
        sessionStatus = status
        sessionRecord()?.let { collector.recordSession(it) }
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /** From the uncaught-exception handler: on Android the process dies next. */
    private fun writeUncaught(throwable: Throwable) {
        capture(
            throwable,
            path = "app/crash",
            attributes = null,
            fatal = true,
            mechanism = "Thread.setDefaultUncaughtExceptionHandler",
            handled = false,
        )
    }

    private fun capture(
        throwable: Throwable,
        path: String,
        attributes: Map<String, Any?>?,
        fatal: Boolean,
        mechanism: String?,
        handled: Boolean = !fatal,
    ) {
        val collector = collector ?: return
        val attrs = linkedMapOf<String, Any?>().apply {
            putAll(device)
            putAll(context)
            installId?.let { put("device.id", it) }
            release?.let { put("release", it) }
            attributes?.let { putAll(it) }
            mechanism?.let { put("sentrinel.mechanism", it) }
            put("sentrinel.handled", handled)
            if (fatal) put("sentrinel.fatal", true)
            sessionId?.let { put("session.id", it) }
            if (crumbs.size > 0) put("breadcrumbs", crumbs.toJson())
        }

        val record = ErrorRecord(
            method = "APP",
            path = if (fatal) "app/crash" else path,
            statusCode = 500,
            timestamp = System.currentTimeMillis(),
            errorType = throwable.javaClass.simpleName.ifEmpty { throwable.javaClass.name },
            errorMessage = throwable.message ?: throwable.javaClass.name,
            stackTrace = throwable.stackTrace.take(64).joinToString("\n"),
            consumerIdentifier = consumer,
            attributes = attrs,
        )

        if (fatal) {
            // On disk first. If the app dies on the next line the report still
            // ships on the next launch; if it lives, the send below removes the
            // disk copy once the server has it. Without a disk this send is the
            // only copy — it used to be dropped.
            val spoolId = if (persistCrashes) spool?.append("error", record.toJson()) else null
            if (persistCrashes) spool?.markSessionCrashed()
            worsenSession(collector, "crashed")
            collector.recordError(record, spoolId)
            // Give the post a moment: on Android the process is killed as soon
            // as the handler returns.
            collector.flushBlocking(if (handled) 0 else 1_500)
        } else {
            collector.recordError(record)
            worsenSession(collector, "errored")
        }
    }
}
