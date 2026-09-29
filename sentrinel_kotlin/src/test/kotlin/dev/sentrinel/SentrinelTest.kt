package dev.sentrinel

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.io.File

class ModelsTest {
    @Test
    fun errorRecordEncodesAsTheWireShape() {
        val record = ErrorRecord(
            method = "APP",
            path = "app/crash",
            statusCode = 500,
            timestamp = 0L,
            errorType = "FatalError",
            errorMessage = "boom",
            stackTrace = "line 1\nline 2",
            consumerIdentifier = "user-1",
            attributes = mapOf("sentrinel.fatal" to true, "device.os" to "ios"),
        )
        val json = record.toJson()
        assertEquals("APP", json["method"])
        assertEquals("app/crash", json["path"])
        assertEquals(500, json["statusCode"])
        assertEquals("FatalError", json["errorType"])
        assertEquals("user-1", json["consumerIdentifier"])
        assertEquals("1970-01-01T00:00:00.000Z", json["timestamp"])
        @Suppress("UNCHECKED_CAST")
        val attrs = json["attributes"] as Map<String, Any?>
        assertEquals(true, attrs["sentrinel.fatal"])
        assertEquals("ios", attrs["device.os"])
    }

    @Test
    fun sessionRecordEncodes() {
        val record = SessionRecord(
            sessionId = "abc",
            status = "ok",
            startedAt = 0L,
            release = "1.4.2",
            distinctId = "user-1",
            deviceOs = "ios",
            deviceOsVersion = "18.0",
        )
        val json = record.toJson()
        assertEquals("abc", json["sessionId"])
        assertEquals("ok", json["status"])
        assertEquals("1.4.2", json["release"])
        assertEquals("ios", json["deviceOs"])
    }

    @Test
    fun spooledRecordsRoundTrip() {
        val error = ErrorRecord("APP", "app/crash", 500, 0L, errorType = "FatalError").toJson()
        val rebuilt = ErrorRecord.fromJson(error)
        assertEquals("app/crash", rebuilt.path)
        assertEquals("FatalError", rebuilt.errorType)

        val session = SessionRecord("abc", "crashed", 0L, release = "1.4.2").toJson()
        val rebuiltSession = SessionRecord.fromJson(session)
        assertEquals("crashed", rebuiltSession.status)
        assertEquals("1.4.2", rebuiltSession.release)
    }
}

class BreadcrumbTrailTest {
    @Test
    fun isBounded() {
        val trail = BreadcrumbTrail(limit = 3)
        for (i in 0 until 10) {
            trail.add(Breadcrumb(System.currentTimeMillis(), "ui", "step $i"))
        }
        assertEquals(3, trail.size)
        val json = trail.toJson()
        assertEquals("step 7", json.first()["message"])
        assertEquals("step 9", json.last()["message"])
    }
}

class CrashSpoolTest {
    private var dir: File? = null
    private lateinit var spool: CrashSpool

    private fun freshSpool(): CrashSpool {
        val d = File.createTempFile("sentrinel-tests-", "").apply { delete(); mkdirs() }
        dir = d
        spool = CrashSpool(d)
        return spool
    }

    private fun cleanup() {
        dir?.deleteRecursively()
    }

    @Test
    fun aRecordStaysOnDiskUntilTheServerHasIt() {
        val spool = freshSpool()
        try {
            val id = spool.append("error", mapOf("method" to "APP", "path" to "app/crash", "statusCode" to 500))
            spool.append("session", mapOf("sessionId" to "s1", "status" to "crashed"))

            val drained = spool.drain()
            assertEquals(2, drained.size)
            assertEquals("error", drained[0].kind)
            assertEquals(id, drained[0].id)
            assertEquals("app/crash", drained[0].json["path"])
            assertEquals("session", drained[1].kind)

            // Read is not delivered: a launch that dies or goes offline before
            // the server answers finds them again.
            assertEquals(2, CrashSpool(dir!!).drain().size)

            spool.acknowledge(listOf(id!!))
            assertEquals(listOf("session"), CrashSpool(dir!!).drain().map { it.kind })
        } finally {
            cleanup()
        }
    }

    @Test
    fun theSpoolIsBoundedPerRun() {
        val spool = freshSpool()
        try {
            repeat(CrashSpool.MAX_RECORDS_PER_RUN) { assertNotNull(spool.append("error", mapOf("n" to it))) }
            assertNull(spool.append("error", mapOf("n" to "one too many")))
        } finally {
            cleanup()
        }
    }

    @Test
    fun anOlderSdksSpoolWithoutIdsStillReplays() {
        val spool = freshSpool()
        try {
            File(dir, "pending.ndjson").writeText(Json.encodeLine("error", mapOf("path" to "app/crash")))
            val drained = spool.drain()
            assertEquals(1, drained.size)
            spool.acknowledge(listOf(drained.single().id))
            assertTrue(CrashSpool(dir!!).drain().isEmpty())
        } finally {
            cleanup()
        }
    }

    @Test
    fun beginSessionDetectsUncleanShutdown() {
        val spool = freshSpool()
        try {
            assertNull(spool.beginSession(mapOf("sessionId" to "s1", "crashed" to false)))
            val previous = spool.beginSession(mapOf("sessionId" to "s2", "crashed" to false))
            assertEquals("s1", previous?.get("sessionId"))
        } finally {
            cleanup()
        }
    }

    @Test
    fun markSessionCrashedFlipsTheMarker() {
        val spool = freshSpool()
        try {
            spool.beginSession(mapOf("sessionId" to "s1", "crashed" to false))
            spool.markSessionCrashed()
            val previous = spool.beginSession(mapOf("sessionId" to "s2", "crashed" to false))
            assertEquals(true, previous?.get("crashed"))
        } finally {
            cleanup()
        }
    }

    @Test
    fun endSessionLeavesNoMarker() {
        val spool = freshSpool()
        try {
            spool.beginSession(mapOf("sessionId" to "s1", "crashed" to false))
            spool.endSession()
            assertNull(spool.beginSession(mapOf("sessionId" to "s2", "crashed" to false)))
        } finally {
            cleanup()
        }
    }
}
