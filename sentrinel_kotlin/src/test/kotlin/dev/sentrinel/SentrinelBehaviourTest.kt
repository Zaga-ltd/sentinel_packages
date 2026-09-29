package dev.sentrinel

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The SDK end to end, against a real socket: what a crash, a second `start`,
 * a second `close`, an Android without a storage property and a dead network
 * each do to what reaches the server.
 */
class SentrinelBehaviourTest {
    private class Post(val path: String, val headers: Map<String, String>, val body: Map<String, Any?>)

    private lateinit var server: HttpServer
    private val posts = CopyOnWriteArrayList<Post>()
    private val status = AtomicInteger(200)
    private lateinit var dir: File
    private lateinit var baseUrl: String

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val text = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            @Suppress("UNCHECKED_CAST")
            val body = Json.parse(text) as Map<String, Any?>
            val headers = exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.first() }
            posts.add(Post(exchange.requestURI.path, headers, body))
            exchange.sendResponseHeaders(status.get(), -1)
            exchange.close()
        }
        server.start()
        baseUrl = "http://127.0.0.1:${server.address.port}"
        dir = File.createTempFile("sentrinel-behaviour-", "").apply { delete(); mkdirs() }
    }

    @AfterTest
    fun tearDown() {
        Sentrinel.close(timeoutMs = 1_000)
        CrashHandler.uninstall()
        server.stop(0)
        dir.deleteRecursively()
    }

    private fun options(persist: Boolean = true, storage: File? = File(dir, "sentrinel")) = Sentrinel.Options(
        serverUrl = baseUrl,
        appName = "fieldops",
        apiKey = "k",
        release = "2.4.0",
        storagePath = storage,
        persistCrashes = persist,
    )

    @Suppress("UNCHECKED_CAST")
    private fun rows(path: String, key: String): List<Map<String, Any?>> =
        posts.filter { it.path == path }.flatMap { (it.body[key] as? List<Map<String, Any?>>) ?: emptyList() }

    private fun eventually(timeoutMs: Long = 5_000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Sentrinel.flush()
            Thread.sleep(50)
        }
        return condition()
    }

    @Test
    fun closeTwiceAndUseAfterCloseAreHarmless() {
        // close() shut the executor down, and the next post threw
        // RejectedExecutionException into the app.
        Sentrinel.start(options())
        Sentrinel.captureError(IllegalStateException("x"))
        Sentrinel.close()
        Sentrinel.close()
        Sentrinel.captureError(IllegalStateException("after"))
        Sentrinel.flush()
        assertFalse(Sentrinel.isStarted)
        assertEquals(1, rows("/api/ingest/errors", "errors").size, "the final flush is sent before close returns")
    }

    @Test
    fun startingTwiceInstallsOneHandlerThatStillChains() {
        // start() chained the handler to itself, so a crash was written once
        // per start().
        val previousCalls = AtomicInteger(0)
        val original = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> previousCalls.incrementAndGet() }
        try {
            Sentrinel.start(options())
            Sentrinel.start(options())
            Thread.getDefaultUncaughtExceptionHandler()!!
                .uncaughtException(Thread.currentThread(), IllegalStateException("boom"))

            // Written once — or already acknowledged and gone. Either way,
            // exactly one row at the server.
            val pending = File(dir, "sentrinel/pending.ndjson")
            if (pending.exists()) assertTrue(pending.readLines().count { it.isNotBlank() } <= 1)
            assertTrue(eventually { rows("/api/ingest/errors", "errors").isNotEmpty() })
            assertEquals(1, rows("/api/ingest/errors", "errors").size)
            assertEquals(1, previousCalls.get(), "the previous handler runs, once")
        } finally {
            CrashHandler.uninstall()
            Thread.setDefaultUncaughtExceptionHandler(original)
        }
    }

    @Test
    fun thePreviousHandlerRunsEvenWhenWritingFails() {
        val previousCalls = AtomicInteger(0)
        val original = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> previousCalls.incrementAndGet() }
        try {
            Sentrinel.start(options())
            CrashHandler.writer = { _, _ -> throw IllegalStateException("writer broke") }
            Thread.getDefaultUncaughtExceptionHandler()!!
                .uncaughtException(Thread.currentThread(), RuntimeException("crash"))
            assertEquals(1, previousCalls.get(), "otherwise the app is left alive in a broken state")
        } finally {
            CrashHandler.uninstall()
            Thread.setDefaultUncaughtExceptionHandler(original)
        }
    }

    @Test
    fun anUncaughtCrashIsSentNowAndReplayedIfItWasNot() {
        status.set(503)
        Sentrinel.start(options())
        CrashHandler.writer!!.invoke(Thread.currentThread(), IllegalStateException("died here"))
        // The server was down; the process dies.
        Sentrinel.abandonForTesting()

        status.set(200)
        posts.clear()
        Sentrinel.start(options())
        assertTrue(eventually {
            rows("/api/ingest/errors", "errors").any { it["errorMessage"] == "died here" }
        })
        assertTrue(Sentrinel.previousRunCrashed)
        assertTrue(eventually { rows("/api/ingest/sessions", "sessions").any { it["status"] == "crashed" } })
        assertTrue(eventually { !File(dir, "sentrinel/inflight.ndjson").exists() }, "acknowledged, so not replayed again")
    }

    @Test
    fun aReplayThatFailsIsKeptForTheNextLaunch() {
        Sentrinel.start(options())
        status.set(503)
        CrashHandler.writer!!.invoke(Thread.currentThread(), IllegalStateException("keep me"))
        Sentrinel.abandonForTesting()

        // Launch two: still down. The old reader had already deleted the file.
        Sentrinel.start(options())
        Thread.sleep(300)
        Sentrinel.abandonForTesting()

        // Launch three: up.
        status.set(200)
        posts.clear()
        Sentrinel.start(options())
        assertTrue(eventually { rows("/api/ingest/errors", "errors").any { it["errorMessage"] == "keep me" } })
    }

    @Test
    fun withoutPersistenceAFatalErrorStillReachesTheServer() {
        // persistCrashes = false used to drop fatal errors entirely.
        Sentrinel.start(options(persist = false))
        Sentrinel.captureError(IllegalStateException("no disk"), fatal = true)
        assertTrue(eventually { rows("/api/ingest/errors", "errors").any { it["errorMessage"] == "no disk" } })
    }

    @Test
    fun theAndroidOverloadPersistsUnderTheGivenDirectory() {
        // On Android `sentrinel.storage` is never set, so nothing was persisted.
        val filesDir = File(dir, "files").apply { mkdirs() }
        Sentrinel.start(options(storage = null), storageDirectory = filesDir)
        assertTrue(File(filesDir, "sentrinel/install.id").exists())
        assertTrue(File(filesDir, "sentrinel/session.json").exists())
    }

    @Test
    fun signedOutTrafficIsThisInstallsGuest() {
        Sentrinel.start(options())
        val id = assertNotNull(Sentrinel.deviceId)
        assertEquals("guest:$id", Sentrinel.consumer)
        Sentrinel.identify("user_42")
        assertEquals("user_42", Sentrinel.consumer)
        assertEquals(mapOf("x-sentrinel-consumer" to "user_42", "x-sentrinel-device" to id), Sentrinel.identityHeaders())
        Sentrinel.identify(null)
        assertEquals("guest:$id", Sentrinel.consumer)

        Sentrinel.close()
        Sentrinel.start(options())
        assertEquals(id, Sentrinel.deviceId, "the install id outlives the process")
    }

    @Test
    fun everyErrorCarriesTheInstallTheSdkAndAUserAgent() {
        Sentrinel.start(options())
        Sentrinel.captureError(IllegalStateException("x"), attributes = mapOf("ratio" to Double.NaN))
        Sentrinel.close()
        val post = posts.first { it.path == "/api/ingest/errors" }
        @Suppress("UNCHECKED_CAST")
        val row = (post.body["errors"] as List<Map<String, Any?>>).single()
        @Suppress("UNCHECKED_CAST")
        val attrs = row["attributes"] as Map<String, Any?>
        assertEquals(Sentrinel.deviceId, attrs["device.id"])
        assertEquals(null, attrs["ratio"], "NaN is null, not a lost batch")
        assertEquals(true, attrs["sentrinel.handled"])
        @Suppress("UNCHECKED_CAST")
        assertEquals("sentrinel.kotlin", (post.body["sdk"] as Map<String, Any?>)["name"])
        assertTrue(post.headers["user-agent"]!!.startsWith("sentrinel.kotlin/"))
    }

    @Test
    fun aHandledErrorMarksTheSessionErroredNotCrashed() {
        Sentrinel.start(options())
        Sentrinel.captureError(IllegalStateException("x"))
        Sentrinel.close()
        val statuses = rows("/api/ingest/sessions", "sessions").map { it["status"] }
        assertTrue("errored" in statuses)
        assertFalse("crashed" in statuses)
    }

    @Test
    fun backgroundingEndsTheSessionSoAnOsKillIsNotAbnormal() {
        Sentrinel.start(options())
        Sentrinel.onBackground()
        assertTrue(eventually { rows("/api/ingest/sessions", "sessions").any { it["durationMs"] != null } })
        assertFalse(File(dir, "sentrinel/session.json").exists())
        Sentrinel.abandonForTesting() // killed while backgrounded

        posts.clear()
        Sentrinel.start(options())
        assertFalse(Sentrinel.previousRunCrashed)
    }

    @Test
    fun androidIsReadFromBuildNotFromTheKernel() {
        // The JVM properties say "linux" and a kernel version on Android.
        val facts = Device.facts(buildClass = "dev.sentrinel.fake.Build")
        assertEquals("Android", facts.os)
        assertEquals("14", facts.osVersion)
        assertEquals("Google Pixel 8", facts.model)
        assertEquals("sentrinel.kotlin/${SentrinelSdk.VERSION} (Android 14; Mobile)", Device.userAgent(facts))

        val jvm = Device.facts(buildClass = "does.not.Exist")
        assertFalse(jvm.isAndroid)
        assertEquals("desktop", jvm.deviceType)
    }
}
