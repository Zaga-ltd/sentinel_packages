// ─── Sentrinel Swift SDK tests ──────────────────────────────────────────────

import XCTest
import Darwin
@testable import Sentrinel

// MARK: - A stub server

/// Answers every request the SDK makes, and remembers the bodies.
final class StubProtocol: URLProtocol {
    static let lock = NSLock()
    static var status = 200
    static var fail = false
    static var bodies: [(path: String, json: [String: Any], headers: [String: String])] = []

    static func reset(status: Int = 200, fail: Bool = false) {
        lock.lock()
        self.status = status
        self.fail = fail
        bodies = []
        lock.unlock()
    }

    static func rows(_ path: String, _ key: String) -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return bodies.filter { $0.path.hasSuffix(path) }.flatMap { ($0.json[key] as? [[String: Any]]) ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            while stream.hasBytesAvailable {
                let n = stream.read(buffer, maxLength: size)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            buffer.deallocate()
            stream.close()
        }
        Self.lock.lock()
        let fail = Self.fail
        let status = Self.status
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            Self.bodies.append((request.url?.path ?? "", json, request.allHTTPHeaderFields ?? [:]))
        }
        Self.lock.unlock()

        if fail {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func stubConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    return config
}

func tempDir() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("sentrinel-tests-\(UUID().uuidString)", isDirectory: true)
}

func options(_ dir: URL?, persist: Bool = true) -> Sentrinel.Options {
    var o = Sentrinel.Options(
        serverUrl: URL(string: "https://api.test")!,
        appName: "mobile-app",
        apiKey: "k",
        release: "1.4.2",
        storagePath: dir,
        persistCrashes: persist,
        installCrashHandlers: false,
        trackLifecycle: false
    )
    o.urlSessionConfiguration = stubConfiguration()
    return o
}

func flushAndWait(_ timeout: TimeInterval = 5) {
    let done = expectationless()
    Sentrinel.flush { done.signal() }
    _ = done.wait(timeout: .now() + timeout)
}

func expectationless() -> DispatchSemaphore { DispatchSemaphore(value: 0) }

/// Flush and re-check until [condition] holds or [timeout] passes.
func eventually(_ timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        flushAndWait(1)
        Thread.sleep(forTimeInterval: 0.05)
    }
    return condition()
}

struct Boom: Error {}

// MARK: - Wire shape

final class ModelsTests: XCTestCase {
    func testErrorRecordEncodesAsTheWireShape() throws {
        let record = ErrorRecord(
            path: "app/crash",
            statusCode: 500,
            errorType: "FatalError",
            errorMessage: "boom",
            stackTrace: "line 1\nline 2",
            consumerIdentifier: "user-1",
            attributes: ["sentrinel.fatal": true, "device.os": "ios"]
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any]

        XCTAssertEqual(json?["method"] as? String, "APP")
        XCTAssertEqual(json?["path"] as? String, "app/crash")
        XCTAssertEqual(json?["statusCode"] as? Int, 500)
        XCTAssertEqual(json?["errorType"] as? String, "FatalError")
        XCTAssertEqual(json?["consumerIdentifier"] as? String, "user-1")
        XCTAssertEqual(json?["timestamp"] as? String, ErrorRecord.iso(record.timestamp))
        let attrs = json?["attributes"] as? [String: Any]
        XCTAssertEqual(attrs?["sentrinel.fatal"] as? Bool, true)
        XCTAssertEqual(attrs?["device.os"] as? String, "ios")
    }

    func testSessionRecordEncodes() throws {
        let record = SessionRecord(
            sessionId: "abc",
            status: "ok",
            startedAt: Date(timeIntervalSince1970: 0),
            release: "1.4.2",
            distinctId: "user-1",
            deviceOs: "iOS",
            deviceOsVersion: "18.0"
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any]
        XCTAssertEqual(json?["sessionId"] as? String, "abc")
        XCTAssertEqual(json?["status"] as? String, "ok")
        XCTAssertEqual(json?["release"] as? String, "1.4.2")
        XCTAssertEqual(json?["deviceOs"] as? String, "iOS")
    }

    /// One NaN used to fail the encode of the whole batch, which then went out
    /// as `{"errors":null}`.
    func testNonFiniteNumbersEncodeAsNull() throws {
        let record = ErrorRecord(path: "app", attributes: [
            "nan": Double.nan, "inf": Double.infinity, "f": Float.nan,
            "ns": NSNumber(value: Double.nan), "ok": 1.5, "n": 3, "b": true,
        ])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any]
        let attrs = json?["attributes"] as? [String: Any]
        XCTAssertTrue(attrs?["nan"] is NSNull)
        XCTAssertTrue(attrs?["inf"] is NSNull)
        XCTAssertTrue(attrs?["f"] is NSNull)
        XCTAssertTrue(attrs?["ns"] is NSNull)
        XCTAssertEqual(attrs?["ok"] as? Double, 1.5)
        XCTAssertEqual(attrs?["n"] as? Int, 3)
        XCTAssertEqual(attrs?["b"] as? Bool, true)
    }
}

final class BreadcrumbTrailTests: XCTestCase {
    func testIsBounded() {
        var trail = BreadcrumbTrail(limit: 3)
        for i in 0..<10 {
            trail.add(Breadcrumb(category: "ui", message: "step \(i)"))
        }
        XCTAssertEqual(trail.count, 3)
        let json = trail.json
        XCTAssertEqual(json.first?["message"] as? String, "step 7")
        XCTAssertEqual(json.last?["message"] as? String, "step 9")
    }
}

// MARK: - The spool

final class CrashSpoolTests: XCTestCase {
    var spool: CrashSpool!
    var dir: URL!

    override func setUp() {
        super.setUp()
        dir = tempDir()
        spool = CrashSpool(directory: dir)
        spool.open()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    func testARecordStaysUntilTheServerHasIt() throws {
        let id = try XCTUnwrap(spool.append(kind: "error", record: Data(#"{"path":"app/crash"}"#.utf8)))
        spool.append(kind: "session", record: Data(#"{"sessionId":"s1","status":"crashed"}"#.utf8))

        let drained = spool.drain()
        XCTAssertEqual(drained.count, 2)
        XCTAssertEqual(drained[0].kind, "error")
        XCTAssertEqual(drained[0].id, id)
        XCTAssertEqual(drained[0].json["path"] as? String, "app/crash")

        // Read is not delivered: a launch that dies or goes offline before the
        // server answers finds them again.
        XCTAssertEqual(CrashSpool(directory: dir).drain().count, 2)

        spool.acknowledge([id])
        let left = CrashSpool(directory: dir).drain()
        XCTAssertEqual(left.map(\.kind), ["session"])
    }

    func testATruncatedTrailingLineDoesNotLoseTheRest() throws {
        spool.append(kind: "error", record: Data(#"{"n":1}"#.utf8))
        let handle = try FileHandle(forWritingTo: spool.pendingURL)
        handle.seekToEndOfFile()
        handle.write(Data(#"{"id":"x","kind":"error","rec"#.utf8))
        try handle.close()
        XCTAssertEqual(spool.drain().count, 1)
    }

    func testBeginSessionDetectsUncleanShutdown() {
        XCTAssertNil(spool.beginSession(["sessionId": "s1", "crashed": false]))
        let previous = spool.beginSession(["sessionId": "s2", "crashed": false])
        XCTAssertEqual(previous?["sessionId"] as? String, "s1")
    }

    func testMarkSessionCrashedFlipsTheMarkerOnce() {
        _ = spool.beginSession(["sessionId": "s1", "crashed": false])
        spool.markSessionCrashed()
        spool.markSessionCrashed()
        let previous = spool.beginSession(["sessionId": "s2", "crashed": false])
        XCTAssertEqual(previous?["crashed"] as? Bool, true)
    }

    func testEndSessionLeavesNoMarker() {
        _ = spool.beginSession(["sessionId": "s1", "crashed": false])
        spool.endSession()
        XCTAssertNil(spool.beginSession(["sessionId": "s2", "crashed": false]))
    }
}

// MARK: - The crash writers

final class CrashWriterTests: XCTestCase {
    var dir: URL!
    var spool: CrashSpool!

    override func setUp() {
        super.setUp()
        dir = tempDir()
        spool = CrashSpool(directory: dir)
        CrashHandler.prepare(fd: spool.open())
        sentrinelExceptionRecorded = 0
        sentrinelHandling = 0
        let prefix = Sentrinel.crashPrefix([
            "device.id": "abc", "session.id": "s1", "sentrinel.fatal": true,
        ])!
        CrashHandler.setTemplate(prefix)
    }

    override func tearDown() {
        CrashHandler.prepare(fd: -1)
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    /// The signal path writes a line that parses as the ordinary error shape —
    /// using only a pre-rendered buffer, the clock, and write(2).
    func testTheSignalRecordIsValidJSONInTheWireShape() throws {
        sentrinelWriteSignalRecord(SIGSEGV)
        let records = spool.drain()
        XCTAssertEqual(records.count, 1)
        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record.kind, "error")
        XCTAssertEqual(record.json["errorType"] as? String, "Signal")
        XCTAssertEqual(record.json["errorMessage"] as? String, "SIGSEGV")
        XCTAssertEqual(record.json["path"] as? String, "app/crash")
        let timestamp = try XCTUnwrap(record.json["timestamp"] as? String)
        let parsed = try XCTUnwrap(ErrorRecord.isoFormatter.date(from: timestamp))
        XCTAssertLessThan(abs(parsed.timeIntervalSinceNow), 5)
        XCTAssertTrue((record.json["stackTrace"] as? String ?? "").hasPrefix("0x"))
        let attrs = try XCTUnwrap(record.json["attributes"] as? [String: Any])
        XCTAssertEqual(attrs["sentrinel.mechanism"] as? String, "sigaction")
        XCTAssertEqual(attrs["sentrinel.fatal"] as? Bool, true)
        XCTAssertEqual(attrs["session.id"] as? String, "s1")
    }

    /// Swift traps arrive as SIGTRAP on arm64; the old handler never listened.
    func testSwiftTrapsAreAmongTheSignalsHandled() {
        XCTAssertTrue(sentrinelFatalSignals.contains(SIGTRAP))
        sentrinelWriteSignalRecord(SIGTRAP)
        XCTAssertEqual(spool.drain().first?.json["errorMessage"] as? String, "SIGTRAP")
    }

    /// An uncaught NSException ends in abort(): one crash, one report.
    func testAnExceptionAndTheAbortItCausesAreOneReport() throws {
        let exception = NSException(name: .invalidArgumentException, reason: "bad \"input\"\n", userInfo: nil)
        sentrinelWriteException(exception)
        // What the SIGABRT handler checks before writing.
        if !(sentrinelExceptionRecorded != 0) { sentrinelWriteSignalRecord(SIGABRT) }

        let records = spool.drain()
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.json["errorType"] as? String, "NSException")
        XCTAssertEqual(records.first?.json["errorMessage"] as? String,
                       "NSInvalidArgumentException: bad \"input\"\n")
    }

    func testTheTimestampIsCivilTimeInUTC() {
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
        defer { buffer.deallocate() }
        var off = 0
        sentrinelAppendTimestamp(buffer, &off)
        let text = String(decoding: UnsafeBufferPointer(start: buffer, count: off), as: UTF8.self)
        let parsed = ErrorRecord.isoFormatter.date(from: text)
        XCTAssertNotNil(parsed, text)
        XCTAssertLessThan(abs(parsed!.timeIntervalSinceNow), 5)
    }
}

// MARK: - The SDK end to end

final class SentrinelTests: XCTestCase {
    var dir: URL!

    override func setUp() {
        super.setUp()
        dir = tempDir()
        StubProtocol.reset()
    }

    override func tearDown() {
        Sentrinel.close(timeout: 1)
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    /// `close()` twice, and anything after it, used to raise an Objective-C
    /// exception from an invalidated URLSession — crashing the host app.
    /// The README's start snippet, verbatim — the old one did not compile.
    func testTheReadmeSnippetCompiles() {
        let options: Sentrinel.Options = .init(
            serverUrl: URL(string: "https://api.sentrinel.dev")!,
            appName: "shop",
            env: "prod",
            apiKey: "<a Mobile key>",
            module: "ios",
            release: "1.4.2"
        )
        XCTAssertEqual(options.module, "ios")
    }

    func testCloseTwiceAndUseAfterCloseAreHarmless() {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom())
        Sentrinel.close(timeout: 1)
        Sentrinel.close(timeout: 1)
        Sentrinel.captureError(Boom())
        Sentrinel.flush()
        XCTAssertFalse(Sentrinel.isStarted)
    }

    func testTheFinalFlushIsNotCancelled() {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom(), path: "checkout")
        Sentrinel.close(timeout: 5)
        XCTAssertEqual(StubProtocol.rows("/api/ingest/errors", "errors").count, 1)
    }

    func testSignedOutTrafficIsThisInstallsGuest() throws {
        Sentrinel.start(options: options(dir))
        let id = try XCTUnwrap(Sentrinel.deviceId)
        XCTAssertEqual(Sentrinel.consumer, "guest:\(id)")

        Sentrinel.identify("user_42")
        XCTAssertEqual(Sentrinel.consumer, "user_42")
        XCTAssertEqual(Sentrinel.identityHeaders["x-sentrinel-consumer"], "user_42")
        XCTAssertEqual(Sentrinel.identityHeaders["x-sentrinel-device"], id)

        Sentrinel.identify(nil)
        XCTAssertEqual(Sentrinel.consumer, "guest:\(id)")

        // The id outlives the process.
        Sentrinel.close(timeout: 1)
        Sentrinel.start(options: options(dir))
        XCTAssertEqual(Sentrinel.deviceId, id)
    }

    func testEveryErrorCarriesTheInstallAndTheConsumer() throws {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom())
        flushAndWait()
        let error = try XCTUnwrap(StubProtocol.rows("/api/ingest/errors", "errors").first)
        let attrs = try XCTUnwrap(error["attributes"] as? [String: Any])
        XCTAssertEqual(attrs["device.id"] as? String, Sentrinel.deviceId)
        XCTAssertEqual(error["consumerIdentifier"] as? String, Sentrinel.consumer)
    }

    func testABatchWithANaNStillArrives() {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom(), attributes: ["ratio": Double.nan])
        Sentrinel.captureError(Boom(), attributes: ["fine": 1])
        flushAndWait()
        XCTAssertEqual(StubProtocol.rows("/api/ingest/errors", "errors").count, 2)
    }

    func testAHandledErrorMarksTheSessionErroredNotCrashed() {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom())
        flushAndWait()
        let statuses = StubProtocol.rows("/api/ingest/sessions", "sessions").compactMap { $0["status"] as? String }
        XCTAssertTrue(statuses.contains("errored"))
        XCTAssertFalse(statuses.contains("crashed"))
    }

    func testTheSDKAndDeviceAreNamedOnEveryPost() throws {
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom())
        flushAndWait()
        StubProtocol.lock.lock()
        let post = StubProtocol.bodies.first { $0.path.hasSuffix("errors") }
        StubProtocol.lock.unlock()
        let body = try XCTUnwrap(post)
        XCTAssertEqual((body.json["sdk"] as? [String: Any])?["name"] as? String, "sentrinel.swift")
        XCTAssertTrue((body.headers["User-Agent"] ?? "").hasPrefix("sentrinel.swift/"))
    }

    /// A fatal error is on disk before the call returns, sent now as well, and
    /// its disk copy removed once the server has it — never delivered twice.
    func testAFatalErrorIsWrittenAheadAndRemovedAfterA2xx() throws {
        // Offline first, so the disk copy can be looked at before a 2xx
        // removes it.
        StubProtocol.reset(fail: true)
        Sentrinel.start(options: options(dir))
        Sentrinel.captureError(Boom(), fatal: true)
        let pending = dir.appendingPathComponent("pending.ndjson")
        XCTAssertTrue((try String(contentsOf: pending, encoding: .utf8)).contains("app/crash"))
        Thread.sleep(forTimeInterval: 0.3) // the immediate send fails, and is requeued

        StubProtocol.reset()
        XCTAssertTrue(eventually { !StubProtocol.rows("/api/ingest/errors", "errors").isEmpty })
        XCTAssertTrue(eventually { (try? String(contentsOf: pending, encoding: .utf8)) == "" },
                      "delivered, so not replayed next launch")
        XCTAssertEqual(StubProtocol.rows("/api/ingest/errors", "errors").count, 1)
    }

    /// A replay that meets a dead network is kept for the next launch, and a
    /// crash leaves the previous session `crashed`, not `abnormal`.
    func testAReplayThatFailsIsTriedAgainNextLaunch() throws {
        // Launch one: a signal crash, written by the handler's own path.
        Sentrinel.start(options: options(dir))
        sentrinelHandling = 0
        sentrinelExceptionRecorded = 0
        sentrinelWriteSignalRecord(SIGSEGV)
        Sentrinel.abandonForTesting() // the process dies

        // Launch two: offline. The old reader had already deleted the file.
        StubProtocol.reset(fail: true)
        Sentrinel.start(options: options(dir))
        flushAndWait()
        // Let the launch's own replay attempt fail before the process "dies",
        // or it could land after the network comes back in launch three.
        Thread.sleep(forTimeInterval: 0.3)
        Sentrinel.abandonForTesting()

        // Launch three: online.
        StubProtocol.reset()
        Sentrinel.start(options: options(dir))
        let delivered = eventually {
            StubProtocol.rows("/api/ingest/errors", "errors")
                .contains { $0["errorMessage"] as? String == "SIGSEGV" }
        }
        XCTAssertTrue(delivered)
        let inflight = dir.appendingPathComponent("inflight.ndjson").path
        XCTAssertTrue(eventually { !FileManager.default.fileExists(atPath: inflight) },
                      "acknowledged records leave the disk")
        XCTAssertEqual(StubProtocol.rows("/api/ingest/errors", "errors")
            .filter { $0["errorMessage"] as? String == "SIGSEGV" }.count, 1)
    }

    /// The same run retries a failed replay on its next flush, too.
    func testAReplayIsRetriedWithinTheSameRun() {
        Sentrinel.start(options: options(dir))
        sentrinelHandling = 0
        sentrinelWriteSignalRecord(SIGBUS)
        Sentrinel.abandonForTesting()

        StubProtocol.reset(fail: true)
        Sentrinel.start(options: options(dir))
        Thread.sleep(forTimeInterval: 0.3) // the launch replay fails and is requeued
        StubProtocol.reset()
        XCTAssertTrue(eventually {
            StubProtocol.rows("/api/ingest/errors", "errors")
                .contains { $0["errorMessage"] as? String == "SIGBUS" }
        })
    }

    /// A signal handler cannot flip the session marker, so the next launch
    /// reads the crash from the fatal record that names the session.
    func testASignalCrashMarksThePreviousSessionCrashed() {
        Sentrinel.start(options: options(dir))
        sentrinelHandling = 0
        sentrinelExceptionRecorded = 0
        sentrinelWriteSignalRecord(SIGABRT)
        Sentrinel.abandonForTesting()

        StubProtocol.reset()
        Sentrinel.start(options: options(dir))
        XCTAssertTrue(Sentrinel.previousRunCrashed)
        func statuses() -> [String] {
            StubProtocol.rows("/api/ingest/sessions", "sessions").compactMap { $0["status"] as? String }
        }
        XCTAssertTrue(eventually { statuses().contains("crashed") })
        XCTAssertFalse(statuses().contains("abnormal"))
    }

    func testAKillWithoutACrashIsAbnormal() {
        Sentrinel.start(options: options(dir))
        Sentrinel.abandonForTesting()
        StubProtocol.reset()
        Sentrinel.start(options: options(dir))
        flushAndWait()
        let statuses = StubProtocol.rows("/api/ingest/sessions", "sessions").compactMap { $0["status"] as? String }
        XCTAssertTrue(statuses.contains("abnormal"))
    }

    func testBackgroundingEndsTheSessionWithADuration() {
        Sentrinel.start(options: options(dir))
        Sentrinel.didEnterBackground()
        Thread.sleep(forTimeInterval: 0.3)
        let ended = StubProtocol.rows("/api/ingest/sessions", "sessions").filter { $0["durationMs"] != nil }
        XCTAssertFalse(ended.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("session.json").path))

        Sentrinel.willEnterForeground()
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("session.json").path))
    }
}
