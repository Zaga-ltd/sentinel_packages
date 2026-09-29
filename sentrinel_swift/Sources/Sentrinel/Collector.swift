// ─── Buffering and flushing telemetry to the Sentrinel API ──────────────────
//
// The design constraint on a phone is the same one the Flutter SDK documents:
// the network is unreliable and expensive, and the app may be killed at any
// moment. So this never blocks the caller, never retries forever, and drops
// rather than grows when it cannot reach the server — a monitoring SDK that
// makes the app crash is worse than no SDK.
//
// The exception is a record that is also on disk (a crash report). Those are
// retried until the server has them, then their disk copy is removed.

import Foundation

/// What the collector will not exceed while offline.
enum Limits {
    static let maxBufferedErrors = 200
    static let maxBufferedSessions = 200
}

/// Buffers records in memory and flushes batches to the ingest endpoints.
///
/// Thread-safe: crash handlers, the timer and the app may call in from any
/// thread. Buffers are guarded by a lock and snapshotted before posting, so
/// records arriving mid-flush are not lost.
final class Collector {
    /// A record already encoded — at record time, so one value that cannot be
    /// encoded costs that record and never the batch — plus the spool id that
    /// removes its disk copy once it is delivered.
    struct Entry {
        let data: Data
        let spoolId: String?
    }

    private enum Outcome { case delivered, rejected, failed }

    private let serverUrl: URL
    private let appName: String
    private let env: String
    private let apiKey: String?
    private let module: String?
    private let session: URLSession

    /// Sent as the User-Agent so the server reads the device, not CFNetwork.
    var userAgent: String?

    /// Told the spool ids of records the server now has (or refused for good).
    var onDelivered: (([String]) -> Void)?

    private let lock = NSLock()
    private var errors: [Entry] = []
    private var replayed: [String: [Entry]] = [:]
    private var sessions: [String: SessionRecord] = [:]
    private var timer: DispatchSourceTimer?
    private var warned = false

    /// No new records, no new flushes. Set by [stop].
    private var stopped = false

    /// The URLSession has been invalidated; creating a task on it now raises
    /// an Objective-C exception, which is how a second `close()` used to crash
    /// the app.
    private var invalidated = false

    private static var encoder: JSONEncoder { makeEncoder() }

    /// How many records were dropped: a full buffer, or a record that could
    /// not be encoded.
    private(set) var droppedRecords = 0

    init(
        serverUrl: URL,
        appName: String,
        env: String,
        apiKey: String?,
        module: String? = nil,
        flushInterval: TimeInterval = 30,
        userAgent: String? = nil,
        configuration: URLSessionConfiguration? = nil
    ) {
        self.serverUrl = serverUrl
        self.appName = appName
        self.env = env
        self.apiKey = apiKey
        self.module = module
        self.userAgent = userAgent
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)

        // A dispatch timer rather than `Timer`: a Timer only fires on a thread
        // with a running run loop, so starting from a background thread meant
        // nothing was ever flushed on schedule.
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + flushInterval, repeating: flushInterval, leeway: .seconds(5))
        timer.setEventHandler { [weak self] in self?.flush() }
        timer.resume()
        self.timer = timer
    }

    deinit {
        timer?.cancel()
    }

    // ─── Recording ─────────────────────────────────────────────────────────

    func recordError(_ error: ErrorRecord, spoolId: String? = nil) {
        guard let data = encode(error) else { return }
        recordEncodedError(data, spoolId: spoolId)
    }

    func recordEncodedError(_ data: Data, spoolId: String? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        push(&errors, Entry(data: data, spoolId: spoolId), max: Limits.maxBufferedErrors)
    }

    /// A record replayed from disk, kept byte-for-byte: its timestamps belong
    /// to the crash, not to this launch.
    func recordRaw(kind: String, json: [String: Any], spoolId: String) {
        guard JSONSerialization.isValidJSONObject(json),
              let data = try? JSONSerialization.data(withJSONObject: json)
        else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        push(&replayed[kind, default: []], Entry(data: data, spoolId: spoolId), max: Limits.maxBufferedErrors)
    }

    /// Sessions are keyed, not appended: a session reported at start and again
    /// at end must send one row, not two.
    func recordSession(_ session: SessionRecord) {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        if sessions.count >= Limits.maxBufferedSessions, sessions[session.sessionId] == nil {
            sessions.removeValue(forKey: sessions.keys.first ?? "")
            droppedRecords += 1
        }
        sessions[session.sessionId] = session
    }

    private func push(_ buffer: inout [Entry], _ entry: Entry, max: Int) {
        if buffer.count >= max {
            buffer.removeFirst()
            droppedRecords += 1
        }
        buffer.append(entry)
    }

    private func encode<T: Encodable>(_ value: T) -> Data? {
        do {
            return try Self.encoder.encode(value)
        } catch {
            lock.lock()
            droppedRecords += 1
            lock.unlock()
            return nil
        }
    }

    /// Number of records waiting to be sent.
    var pending: Int {
        lock.lock()
        defer { lock.unlock() }
        return errors.count + sessions.count + replayed.values.reduce(0) { $0 + $1.count }
    }

    // ─── Flushing ──────────────────────────────────────────────────────────

    /// Send everything buffered. [completion] runs once every post has
    /// answered (or failed) — use it to hold a background task open.
    func flush(completion: (() -> Void)? = nil) {
        lock.lock()
        if stopped {
            lock.unlock()
            completion?()
            return
        }
        lock.unlock()
        flushNow(completion: completion)
    }

    private func flushNow(completion: (() -> Void)?) {
        lock.lock()
        let liveErrors = errors
        let replayedErrors = replayed["error"] ?? []
        let replayedSessions = replayed["session"] ?? []
        let sessions = Array(self.sessions.values)
        errors.removeAll()
        replayed.removeAll()
        self.sessions.removeAll()
        lock.unlock()

        let group = DispatchGroup()
        let allErrors = replayedErrors + liveErrors
        if !allErrors.isEmpty {
            send("errors", allErrors, kind: "error", group: group)
        }
        let sessionEntries = replayedSessions
            + sessions.compactMap { s in encode(s).map { Entry(data: $0, spoolId: nil) } }
        if !sessionEntries.isEmpty {
            send("sessions", sessionEntries, kind: "session", group: group)
        }
        group.notify(queue: DispatchQueue.global(qos: .utility)) { completion?() }
    }

    /// Stop for good: no timer, no new records. The final flush is allowed to
    /// finish — `finishTasksAndInvalidate`, not `invalidateAndCancel`, which
    /// cancelled the very flush it followed. Safe to call twice.
    func stop(completion: (() -> Void)? = nil) {
        lock.lock()
        if stopped {
            lock.unlock()
            completion?()
            return
        }
        stopped = true
        lock.unlock()

        timer?.cancel()
        timer = nil
        flushNow { completion?() }

        lock.lock()
        invalidated = true
        lock.unlock()
        session.finishTasksAndInvalidate()
    }

    /// Test seam: what a process that dies looks like from outside — nothing
    /// more is sent, nothing is acknowledged.
    func abandon() {
        lock.lock()
        stopped = true
        invalidated = true
        errors.removeAll()
        replayed.removeAll()
        sessions.removeAll()
        onDelivered = nil
        lock.unlock()
        timer?.cancel()
        timer = nil
        session.invalidateAndCancel()
    }

    private func send(_ path: String, _ entries: [Entry], kind: String, group: DispatchGroup) {
        guard let body = body(path, entries) else { return }
        group.enter()
        post(path: path, body: body) { [weak self] outcome in
            defer { group.leave() }
            guard let self else { return }
            let durable = entries.filter { $0.spoolId != nil }
            guard !durable.isEmpty else { return }
            switch outcome {
            case .delivered, .rejected:
                self.onDelivered?(durable.compactMap(\.spoolId))
            case .failed:
                // Back in line for the next flush; the disk copy stays for the
                // next launch if this one never gets through.
                self.lock.lock()
                if !self.stopped {
                    for entry in durable {
                        self.push(&self.replayed[kind, default: []], entry, max: Limits.maxBufferedErrors)
                    }
                }
                self.lock.unlock()
            }
        }
    }

    /// `{appName, env, module?, sdk, <key>: [rows]}` — assembled from the
    /// already-encoded rows, so no row is encoded twice and none can fail the
    /// envelope.
    private func body(_ key: String, _ entries: [Entry]) -> Data? {
        var header: [String: Any] = [
            "appName": appName,
            "env": env,
            "sdk": ["name": SentrinelSDK.name, "version": SentrinelSDK.version],
        ]
        if let module { header["module"] = module }
        guard var data = try? JSONSerialization.data(withJSONObject: header),
              data.last == UInt8(ascii: "}")
        else { return nil }
        data.removeLast()
        data.append(Data(",\"\(key)\":[".utf8))
        for (i, entry) in entries.enumerated() {
            if i > 0 { data.append(UInt8(ascii: ",")) }
            data.append(entry.data)
        }
        data.append(Data("]}".utf8))
        return data
    }

    private func post(path: String, body: Data, done: @escaping (Outcome) -> Void) {
        let url = serverUrl.appendingPathComponent("/api/ingest/\(path)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey { request.setValue(apiKey, forHTTPHeaderField: "x-api-key") }
        if let userAgent { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        request.httpBody = body

        lock.lock()
        guard !invalidated else {
            lock.unlock()
            done(.failed)
            return
        }
        let task = session.dataTask(with: request) { [weak self] _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                done(.failed) // offline — only a disk-backed record is retried
                return
            }
            if http.statusCode < 300 {
                done(.delivered)
                return
            }
            self?.warnOnce(http.statusCode)
            done([400, 413, 422].contains(http.statusCode) ? .rejected : .failed)
        }
        lock.unlock()
        task.resume()
    }

    /// One warning per process. A monitoring SDK that spams the console during
    /// an outage is its own kind of incident.
    private func warnOnce(_ status: Int) {
        lock.lock()
        let already = warned
        warned = true
        lock.unlock()
        if already { return }
        var hint = ""
        if status == 401 || status == 403 {
            hint = "Check apiKey and env — the key must be issued for this environment."
        } else if status == 429 {
            hint = "Over quota."
        }
        NSLog("[sentrinel] telemetry rejected (\(status)). \(hint)")
    }
}
