package dev.sentrinel

import java.net.HttpURLConnection
import java.net.URL
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * Buffers records in memory and flushes batches to the Sentrinel API.
 *
 * The design constraint on a phone is the same one the Flutter and Swift SDKs
 * document: the network is unreliable and expensive, and the app may be killed
 * at any moment. So this never blocks the caller, never retries forever, and
 * drops rather than grows when it cannot reach the server — a monitoring SDK
 * that causes the crash it was installed to report is worse than no SDK.
 *
 * The exception is a record that is also on disk (a crash report): those are
 * retried until the server has them, then their disk copy is removed.
 */
internal class Collector(
    private val serverUrl: String,
    private val appName: String,
    private val env: String,
    private val apiKey: String?,
    private val module: String? = null,
    private val flushIntervalMs: Long = 30_000,
    @Volatile var userAgent: String? = null,
) {
    /** A record encoded at record time — so one value that cannot be encoded
     * costs that record, never the batch — and the spool id that removes its
     * disk copy once delivered. */
    private class Entry(val json: String, val spoolId: String?)

    private enum class Outcome { DELIVERED, REJECTED, FAILED }

    private val lock = Any()
    private val errors = mutableListOf<Entry>()
    private val replayed = linkedMapOf<String, MutableList<Entry>>()
    private val sessions = linkedMapOf<String, SessionRecord>()
    private var timer: Timer? = null
    @Volatile private var warned = false
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "sentrinel-post").apply { isDaemon = true }
    }

    /** No new records, no new posts. Posting after the executor shut down used
     * to throw RejectedExecutionException into the app. */
    @Volatile private var stopped = false

    /** Told the spool ids of records the server now has (or refused for good). */
    @Volatile var onDelivered: ((List<String>) -> Unit)? = null

    /** How many records were dropped: a full buffer, or one that failed to encode. */
    @Volatile
    var droppedRecords: Int = 0
        private set

    fun start() {
        synchronized(lock) {
            if (stopped) return
            timer?.cancel()
            timer = Timer("sentrinel-flush", true).apply {
                schedule(object : TimerTask() {
                    override fun run() = flush()
                }, flushIntervalMs, flushIntervalMs)
            }
        }
    }

    fun recordError(record: ErrorRecord, spoolId: String? = null) {
        val json = encode(record.toJson()) ?: return
        synchronized(lock) {
            if (stopped) return
            push(errors, Entry(json, spoolId), Limits.MAX_BUFFERED_ERRORS)
        }
    }

    /** A record replayed from disk, kept as it was written at crash time. */
    fun recordRaw(kind: String, json: Map<String, Any?>, spoolId: String) {
        val encoded = encode(json) ?: return
        synchronized(lock) {
            if (stopped) return
            push(replayed.getOrPut(kind) { mutableListOf() }, Entry(encoded, spoolId), Limits.MAX_BUFFERED_ERRORS)
        }
    }

    /** Sessions are keyed, not appended: a session reported at start and again
     * at end must send one row, not two. */
    fun recordSession(record: SessionRecord) {
        synchronized(lock) {
            if (stopped) return
            if (sessions.size >= Limits.MAX_BUFFERED_SESSIONS && !sessions.containsKey(record.sessionId)) {
                sessions.remove(sessions.keys.firstOrNull())
                droppedRecords++
            }
            sessions[record.sessionId] = record
        }
    }

    private fun push(buffer: MutableList<Entry>, entry: Entry, max: Int) {
        if (buffer.size >= max) {
            buffer.removeAt(0)
            droppedRecords++
        }
        buffer.add(entry)
    }

    private fun encode(json: Map<String, Any?>): String? = try {
        Json.encode(json)
    } catch (_: Throwable) {
        // A cycle in the app's attributes (StackOverflowError), or a toString
        // that throws. That record goes; the batch does not.
        droppedRecords++
        null
    }

    /** Number of records waiting to be sent. Exposed for tests and diagnostics. */
    val pending: Int
        get() = synchronized(lock) { errors.size + sessions.size + replayed.values.sumOf { it.size } }

    /** Send everything buffered, in the background. */
    fun flush() {
        if (stopped) return
        flushNow(null)
    }

    /** Send everything buffered and wait up to [timeoutMs] for the answers. */
    fun flushBlocking(timeoutMs: Long) {
        if (stopped) return
        val latch = CountDownLatch(1)
        flushNow { latch.countDown() }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun flushNow(done: (() -> Unit)?) {
        val (live, replayedErrors, replayedSessions, sessionsSnapshot) = synchronized(lock) {
            val snapshot = Snapshot(
                errors.toList(),
                replayed["error"]?.toList() ?: emptyList(),
                replayed["session"]?.toList() ?: emptyList(),
                sessions.values.toList(),
            )
            errors.clear()
            replayed.clear()
            sessions.clear()
            snapshot
        }
        val batches = mutableListOf<Triple<String, String, List<Entry>>>()
        val allErrors = replayedErrors + live
        if (allErrors.isNotEmpty()) batches.add(Triple("errors", "error", allErrors))
        val allSessions = replayedSessions + sessionsSnapshot.mapNotNull { s -> encode(s.toJson())?.let { Entry(it, null) } }
        if (allSessions.isNotEmpty()) batches.add(Triple("sessions", "session", allSessions))
        if (batches.isEmpty()) {
            done?.invoke()
            return
        }
        val remaining = java.util.concurrent.atomic.AtomicInteger(batches.size)
        for ((path, kind, entries) in batches) {
            send(path, kind, entries) {
                if (remaining.decrementAndGet() == 0) done?.invoke()
            }
        }
    }

    private data class Snapshot(
        val live: List<Entry>,
        val replayedErrors: List<Entry>,
        val replayedSessions: List<Entry>,
        val sessions: List<SessionRecord>,
    )

    /** Stop for good: no timer, no new records; the final flush is sent and
     * waited for, up to [timeoutMs]. Safe to call twice. */
    fun stop(timeoutMs: Long = 2_000) {
        synchronized(lock) {
            if (stopped) return
            timer?.cancel()
            timer = null
        }
        val latch = CountDownLatch(1)
        flushNow { latch.countDown() }
        stopped = true
        executor.shutdown()
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    /** Test seam: what a dead process looks like — nothing more is sent or
     * acknowledged. */
    fun abandon() {
        synchronized(lock) {
            stopped = true
            timer?.cancel()
            timer = null
            errors.clear()
            replayed.clear()
            sessions.clear()
        }
        onDelivered = null
        executor.shutdownNow()
    }

    /** `{appName, env, module?, sdk, <key>: [rows]}`, from the already-encoded
     * rows. */
    private fun body(key: String, entries: List<Entry>): String {
        val header = linkedMapOf<String, Any?>(
            "appName" to appName,
            "env" to env,
            "sdk" to mapOf("name" to SentrinelSdk.NAME, "version" to SentrinelSdk.VERSION),
        )
        module?.let { header["module"] = it }
        val head = Json.encode(header).removeSuffix("}")
        return entries.joinToString(",", prefix = "$head,${Json.encode(key)}:[", postfix = "]}") { it.json }
    }

    private fun send(path: String, kind: String, entries: List<Entry>, done: () -> Unit) {
        val payload = body(path, entries)
        val task = Runnable {
            val outcome = post(path, payload)
            try {
                val durable = entries.filter { it.spoolId != null }
                if (durable.isNotEmpty()) {
                    when (outcome) {
                        Outcome.DELIVERED, Outcome.REJECTED -> onDelivered?.invoke(durable.mapNotNull { it.spoolId })
                        Outcome.FAILED -> synchronized(lock) {
                            // Back in line for the next flush; the disk copy stays
                            // for the next launch if this one never gets through.
                            if (!stopped) {
                                val bucket = replayed.getOrPut(kind) { mutableListOf() }
                                durable.forEach { push(bucket, it, Limits.MAX_BUFFERED_ERRORS) }
                            }
                        }
                    }
                }
            } finally {
                done()
            }
        }
        try {
            executor.execute(task)
        } catch (_: RejectedExecutionException) {
            // Shut down between the check and the post. Nothing to do: the
            // records with a disk copy are still on disk.
            done()
        }
    }

    private fun post(path: String, payload: String): Outcome {
        val url = serverUrl.trimEnd('/') + "/api/ingest/" + path
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 15_000
                conn.setRequestProperty("Content-Type", "application/json")
                apiKey?.let { conn.setRequestProperty("x-api-key", it) }
                userAgent?.let { conn.setRequestProperty("User-Agent", it) }
                conn.doOutput = true
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val status = conn.responseCode
                when {
                    status < 300 -> Outcome.DELIVERED
                    else -> {
                        warnOnce(status)
                        if (status == 400 || status == 413 || status == 422) Outcome.REJECTED else Outcome.FAILED
                    }
                }
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            // Offline, or the server is down. A live batch is gone from the
            // buffer — deliberately; only records with a disk copy are retried.
            Outcome.FAILED
        }
    }

    /** One warning per process. A monitoring SDK that spams the console during
     * an outage is its own kind of incident. */
    private fun warnOnce(status: Int) {
        if (warned) return
        warned = true
        val hint = when (status) {
            401, 403 -> "Check apiKey and env — the key must be issued for this environment."
            429 -> "Over quota."
            else -> ""
        }
        System.err.println("[sentrinel] telemetry rejected ($status). $hint")
    }
}

internal object Limits {
    const val MAX_BUFFERED_ERRORS = 200
    const val MAX_BUFFERED_SESSIONS = 200
}
