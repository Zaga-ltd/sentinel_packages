package dev.sentrinel

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

/**
 * What actually leaves the device, read back off a real socket.
 *
 * The models tests pin the row shape; this pins the envelope around the rows
 * — the project, its environment, and which part of the project this app is —
 * and the key header. An app is the whole project, and a phone that did not
 * say which part it was would be filed under whatever its key happened to be
 * called.
 */
class CollectorWireTest {
    private class Received(val path: String, val apiKey: String?, val body: Map<String, Any?>)

    /** A server on a free port that remembers every batch it was sent. */
    private fun capture(block: (baseUrl: String, posts: LinkedBlockingQueue<Received>) -> Unit) {
        val posts = LinkedBlockingQueue<Received>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val text = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            @Suppress("UNCHECKED_CAST")
            val body = Json.parse(text) as Map<String, Any?>
            posts.add(Received(exchange.requestURI.path, exchange.requestHeaders.getFirst("x-api-key"), body))
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        server.start()
        try {
            block("http://127.0.0.1:${server.address.port}", posts)
        } finally {
            server.stop(0)
        }
    }

    private fun next(posts: LinkedBlockingQueue<Received>): Received =
        assertNotNull(posts.poll(10, TimeUnit.SECONDS), "the collector never posted")

    @Test
    fun aBatchNamesTheProjectItsEnvironmentAndThePart() = capture { baseUrl, posts ->
        val collector = Collector(
            serverUrl = baseUrl,
            appName = "fieldops",
            env = "prod",
            apiKey = "snt_mobile_test",
            module = "android",
        )
        collector.recordError(ErrorRecord("APP", "app/crash", 500, 0L, errorType = "FatalError"))
        collector.recordSession(SessionRecord("s1", "ok", 0L, release = "2.4.0"))
        collector.flush()
        collector.stop()

        val byPath = listOf(next(posts), next(posts)).associateBy { it.path }
        val errors = assertNotNull(byPath["/api/ingest/errors"])
        val sessions = assertNotNull(byPath["/api/ingest/sessions"])

        for (post in listOf(errors, sessions)) {
            assertEquals("fieldops", post.body["appName"])
            assertEquals("prod", post.body["env"])
            assertEquals("android", post.body["module"])
            assertEquals("snt_mobile_test", post.apiKey)
        }
        @Suppress("UNCHECKED_CAST")
        val errorRows = errors.body["errors"] as List<Map<String, Any?>>
        assertEquals("FatalError", errorRows.single()["errorType"])
        @Suppress("UNCHECKED_CAST")
        val sessionRows = sessions.body["sessions"] as List<Map<String, Any?>>
        assertEquals("2.4.0", sessionRows.single()["release"])
    }

    @Test
    fun withoutAModuleNoneIsSentSoTheKeyNamesThePart() = capture { baseUrl, posts ->
        // Sending an empty string would name the part "" rather than letting
        // the server fall back to the key's name.
        val collector = Collector(serverUrl = baseUrl, appName = "fieldops", env = "prod", apiKey = null)
        collector.recordError(ErrorRecord("APP", "app/crash", 500, 0L, errorType = "FatalError"))
        collector.flush()
        collector.stop()

        val post = next(posts)
        assertEquals("/api/ingest/errors", post.path)
        assertFalse(post.body.containsKey("module"))
        assertEquals(null, post.apiKey)
    }
}
