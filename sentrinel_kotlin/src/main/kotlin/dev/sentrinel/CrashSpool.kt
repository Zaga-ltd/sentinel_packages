package dev.sentrinel

import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * On-disk queue for reports that must outlive the process.
 *
 * Everything else buffers in memory and flushes on a timer — right for ordinary
 * telemetry, useless for a crash, because the process is gone long before the
 * next tick. A crash report has to be on disk *before* the app dies, and sent on
 * the next launch.
 *
 * The write is synchronous, append-only and fsync'd. If the process is killed
 * mid-line the worst case is one truncated trailing line, which the reader
 * discards.
 *
 * A record leaves the disk only when the server has it. [drain] moves the queue
 * to `inflight.ndjson` instead of deleting it, and [acknowledge] removes lines
 * after a 2xx. The first version deleted the file as soon as it was read, so a
 * replay that met a dead network — a phone that just crashed on a train — was
 * gone for good.
 */
class CrashSpool(val directory: File) {

    private val pendingFile get() = File(directory, "pending.ndjson")
    private val inflightFile get() = File(directory, "inflight.ndjson")
    private val sessionMarkerFile get() = File(directory, "session.json")
    private val installFile get() = File(directory, "install.id")

    /** Set when the directory turns out unusable — read-only, missing, out of
     * space. The SDK degrades to in-memory rather than throwing into the host
     * app on every single record. */
    @Volatile
    var unusable: Boolean = false
        private set

    private var appended = 0
    private var session: Map<String, Any?>? = null
    private var crashedMarked = false

    private fun ensureDir(): Boolean {
        if (directory.isDirectory || directory.mkdirs()) return true
        unusable = true
        return false
    }

    // ─── Install id ──────────────────────────────────────────────────────────

    @Synchronized
    fun readInstallId(): String? {
        if (unusable) return null
        return try {
            installFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    @Synchronized
    fun writeInstallId(id: String) {
        if (unusable || !ensureDir()) return
        try {
            installFile.writeText(id)
        } catch (_: Exception) {
            // Degrade to a per-run id; never throw.
        }
    }

    // ─── Records ─────────────────────────────────────────────────────────────

    /**
     * Queue a record, synchronously and durably. Returns the id [acknowledge]
     * removes it with, or null when it was not written. Called from the crash
     * handler, where every asynchronous gap is a chance for the process to
     * disappear.
     */
    @Synchronized
    fun append(kind: String, json: Map<String, Any?>): String? {
        if (unusable || appended >= MAX_RECORDS_PER_RUN || !ensureDir()) return null
        val id = UUID.randomUUID().toString().replace("-", "")
        val line = Json.encode(linkedMapOf("id" to id, "kind" to kind, "record" to json)) + "\n"
        return try {
            FileOutputStream(pendingFile, true).use { out ->
                out.write(line.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            appended++
            id
        } catch (_: Exception) {
            // A monitoring SDK must not be the reason a crash gets worse.
            unusable = true
            null
        }
    }

    /** The pre-0.2 name. */
    fun appendSync(kind: String, json: Map<String, Any?>) {
        append(kind, json)
    }

    /**
     * Everything earlier runs left behind, including a previous replay the
     * server never confirmed. Nothing is deleted here: the records move to
     * `inflight.ndjson` until [acknowledge] is called with their ids.
     */
    @Synchronized
    fun drain(): List<SpooledRecord> {
        if (unusable) return emptyList()
        val lines = try {
            listOf(inflightFile, pendingFile)
                .filter { it.exists() }
                .flatMap { it.readText().split("\n") }
        } catch (_: Exception) {
            unusable = true
            return emptyList()
        }

        val seen = HashSet<String>()
        var out = mutableListOf<SpooledRecord>()
        for (rawLine in lines) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue
            try {
                @Suppress("UNCHECKED_CAST")
                val parsed = Json.parse(line) as? Map<String, Any?> ?: continue
                val kind = parsed["kind"] as? String ?: continue
                @Suppress("UNCHECKED_CAST")
                val record = parsed["record"] as? Map<String, Any?> ?: continue
                // Lines from before ids existed get one now; the rewrite below
                // stores it, so acknowledging them works like any other.
                val id = parsed["id"] as? String ?: UUID.randomUUID().toString().replace("-", "")
                if (seen.add(id)) out.add(SpooledRecord(kind, record, id))
            } catch (_: Exception) {
                // A half-written trailing line from a process that died mid-append.
            }
        }
        if (out.size > MAX_REPLAY) out = out.takeLast(MAX_REPLAY).toMutableList()

        // Inflight first, then pending. Dying between the two leaves a record in
        // both, and the id dedupe above folds them back into one.
        try {
            writeRecords(inflightFile, out)
            pendingFile.delete()
        } catch (_: Exception) {
            unusable = true
        }
        return out
    }

    /**
     * The server has these (or refused them for good). Remove them from
     * wherever they are queued.
     */
    @Synchronized
    fun acknowledge(ids: Collection<String>) {
        if (unusable || ids.isEmpty()) return
        val done = ids.toHashSet()
        for (file in listOf(inflightFile, pendingFile)) {
            try {
                if (!file.exists()) continue
                val lines = file.readText().split("\n").filter { it.isNotBlank() }
                val kept = lines.filter { line ->
                    val id = try {
                        (Json.parse(line) as? Map<*, *>)?.get("id") as? String
                    } catch (_: Exception) {
                        null
                    }
                    id == null || id !in done
                }
                if (kept.size == lines.size) continue
                if (kept.isEmpty()) file.delete() else file.writeText(kept.joinToString("\n") + "\n")
            } catch (_: Exception) {
                // Worst case: sent once more on the next launch.
            }
        }
    }

    private fun writeRecords(file: File, records: List<SpooledRecord>) {
        if (records.isEmpty()) {
            file.delete()
            return
        }
        val text = records.joinToString("") {
            Json.encode(linkedMapOf("id" to it.id, "kind" to it.kind, "record" to it.json)) + "\n"
        }
        FileOutputStream(file, false).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
    }

    // ─── Sessions ────────────────────────────────────────────────────────────

    /** Mark a session as running. Returns what the previous session left
     * behind, or null if it shut down cleanly. */
    @Synchronized
    fun beginSession(marker: Map<String, Any?>): Map<String, Any?>? {
        if (unusable || !ensureDir()) return null
        var previous: Map<String, Any?>? = null
        val file = sessionMarkerFile
        if (file.exists()) {
            previous = try {
                @Suppress("UNCHECKED_CAST")
                Json.parse(file.readText()) as? Map<String, Any?> ?: emptyMap()
            } catch (_: Exception) {
                // Unreadable marker still tells us the last run did not close.
                emptyMap()
            }
        }
        writeMarker(marker)
        return previous
    }

    /** Put the marker back for a session that was paused, without treating it
     * as a previous run. */
    @Synchronized
    fun resumeSession(marker: Map<String, Any?>) {
        if (unusable || !ensureDir()) return
        writeMarker(marker)
    }

    private fun writeMarker(marker: Map<String, Any?>) {
        session = marker
        crashedMarked = marker["crashed"] == true
        try {
            sessionMarkerFile.writeText(Json.encode(marker))
        } catch (_: Exception) {
            unusable = true
        }
    }

    /** Note on the live session marker that a fatal error was written — once;
     * the flag is cached, so a second fatal error costs nothing. This is what
     * lets the next launch tell `crashed` from `abnormal`. */
    @Synchronized
    fun markSessionCrashed() {
        if (unusable || crashedMarked) return
        val current = session ?: return
        crashedMarked = true
        val updated = current + ("crashed" to true)
        session = updated
        try {
            sessionMarkerFile.writeText(Json.encode(updated))
        } catch (_: Exception) {
            // The crash report itself is already safely on disk.
        }
    }

    /** Record a clean shutdown, so the next launch does not report a crash. */
    @Synchronized
    fun endSession() {
        session = null
        crashedMarked = false
        if (unusable) return
        try {
            sessionMarkerFile.delete()
        } catch (_: Exception) {
            unusable = true
        }
    }

    /** Test seam. */
    @Synchronized
    fun clear() {
        try {
            pendingFile.delete()
            inflightFile.delete()
            sessionMarkerFile.delete()
        } catch (_: Exception) {
        }
        appended = 0
    }

    companion object {
        /** Records one run may write. A dying process does not produce fifty
         * distinct fatal errors; a loop that does should not fill the disk. */
        const val MAX_RECORDS_PER_RUN = 50

        /** The most one replay carries, newest kept. */
        const val MAX_REPLAY = 100
    }
}

/** One queued record, as read back from storage. */
data class SpooledRecord(val kind: String, val json: Map<String, Any?>, val id: String = "")
