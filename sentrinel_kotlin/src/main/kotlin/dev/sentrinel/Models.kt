package dev.sentrinel

/**
 * The wire shapes, matching the ingest contract in `apps/api/src/routes/ingest.ts`
 * and the Flutter SDK's `models.dart`. A divergence here shows up as a 400, so
 * these stay deliberately close to the TypeScript payloads.
 */

/** One app launch — the denominator for crash-free rate. */
data class SessionRecord(
    val sessionId: String,

    /** `ok` · `crashed` · `abnormal` · `errored`. */
    val status: String,
    val startedAt: Long,
    val release: String? = null,
    val distinctId: String? = null,
    val deviceOs: String? = null,
    val deviceOsVersion: String? = null,
    val durationMs: Double? = null,
) {
    fun toJson(): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>("sessionId" to sessionId)
        out["status"] = status
        out["startedAt"] = iso8601(startedAt)
        release?.let { out["release"] = it }
        distinctId?.let { out["distinctId"] = it }
        deviceOs?.let { out["deviceOs"] = it }
        deviceOsVersion?.let { out["deviceOsVersion"] = it }
        durationMs?.let { out["durationMs"] = it }
        return out
    }

    fun copyWith(status: String = this.status, durationMs: Double? = this.durationMs) =
        copy(status = status, durationMs = durationMs)

    companion object {
        /** Rebuild from a previously-serialised map (crash spool replay). */
        fun fromJson(json: Map<String, Any?>): SessionRecord = SessionRecord(
            sessionId = json["sessionId"] as? String ?: "",
            status = json["status"] as? String ?: "ok",
            startedAt = parseIso8601(json["startedAt"] as? String) ?: System.currentTimeMillis(),
            release = json["release"] as? String,
            distinctId = json["distinctId"] as? String,
            deviceOs = json["deviceOs"] as? String,
            deviceOsVersion = json["deviceOsVersion"] as? String,
            durationMs = (json["durationMs"] as? Number)?.toDouble(),
        )
    }
}

/** A failure — a thrown exception or a crash. */
data class ErrorRecord(
    val method: String,
    val path: String,
    val statusCode: Int,
    val timestamp: Long,
    val statusMessage: String? = null,
    val errorType: String? = null,
    val errorMessage: String? = null,
    val stackTrace: String? = null,
    val consumerIdentifier: String? = null,
    val requestLogId: String? = null,
    val traceId: String? = null,
    val attributes: Map<String, Any?>? = null,
) {
    fun toJson(): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>(
            "method" to method,
            "path" to path,
            "statusCode" to statusCode,
            "timestamp" to iso8601(timestamp),
        )
        statusMessage?.let { out["statusMessage"] = it }
        errorType?.let { out["errorType"] = it }
        errorMessage?.let { out["errorMessage"] = it }
        stackTrace?.let { out["stackTrace"] = it }
        consumerIdentifier?.let { out["consumerIdentifier"] = it }
        requestLogId?.let { out["requestLogId"] = it }
        traceId?.let { out["traceId"] = it }
        attributes?.takeIf { it.isNotEmpty() }?.let { out["attributes"] = it }
        return out
    }

    companion object {
        /** Rebuild from a previously-serialised map (crash spool replay). */
        fun fromJson(json: Map<String, Any?>): ErrorRecord = ErrorRecord(
            method = json["method"] as? String ?: "APP",
            path = json["path"] as? String ?: "app",
            statusCode = (json["statusCode"] as? Number)?.toInt() ?: 500,
            timestamp = parseIso8601(json["timestamp"] as? String) ?: System.currentTimeMillis(),
            statusMessage = json["statusMessage"] as? String,
            errorType = json["errorType"] as? String,
            errorMessage = json["errorMessage"] as? String,
            stackTrace = json["stackTrace"] as? String,
            consumerIdentifier = json["consumerIdentifier"] as? String,
            requestLogId = json["requestLogId"] as? String,
            traceId = json["traceId"] as? String,
            attributes = json["attributes"] as? Map<String, Any?>,
        )
    }
}

/** One thing the app did, kept to explain what led to a failure. */
data class Breadcrumb(
    val timestamp: Long,
    val category: String,
    val message: String,
    val data: Map<String, Any?>? = null,
) {
    fun toJson(): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>(
            "timestamp" to iso8601(timestamp),
            "category" to category,
            "message" to message,
        )
        data?.takeIf { it.isNotEmpty() }?.let { out["data"] = it }
        return out
    }
}

/** A bounded trail of recent activity. Fixed size so an app that runs for hours
 * never accumulates an unbounded list.
 *
 * Synchronized: breadcrumbs are added from any thread, and read by the crash
 * handler on the thread that is dying. An unsynchronized ArrayList read while
 * another thread appended threw ConcurrentModificationException inside the
 * crash handler — and lost the crash. */
class BreadcrumbTrail(private val limit: Int = 25) {
    private val crumbs = mutableListOf<Breadcrumb>()

    @Synchronized
    fun add(crumb: Breadcrumb) {
        crumbs.add(crumb)
        while (crumbs.size > limit) crumbs.removeAt(0)
    }

    @Synchronized
    fun clear() = crumbs.clear()

    val size: Int
        @Synchronized get() = crumbs.size

    @Synchronized
    fun toJson(): List<Map<String, Any?>> = crumbs.map { it.toJson() }
}

/** ISO-8601 UTC with millisecond precision, matching the Dart `toIso8601String`. */
internal fun iso8601(epochMillis: Long): String {
    val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
    cal.timeInMillis = epochMillis
    val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
    sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
    return sdf.format(cal.time)
}

internal fun parseIso8601(raw: String?): Long? {
    if (raw == null) return null
    return try {
        java.time.Instant.parse(raw).toEpochMilli()
    } catch (_: Exception) {
        // A writer without fractional seconds, e.g. "2026-08-07T11:00:00Z".
        try {
            java.time.Instant.parse(raw.replaceFirst(Regex("\\.\\d+"), "")).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }
}
