// ─── On-disk queue for reports that must outlive the process ────────────────
//
// This is the difference between "we noticed an error" and crash reporting.
// Everything else buffers in memory and flushes on a timer — right for ordinary
// telemetry, useless for a crash, because the process is gone long before the
// next tick. A crash report has to be on disk *before* the app dies, and sent
// on the next launch.
//
// The write is append-only NDJSON through one file descriptor opened at start,
// so the signal handler can use it with nothing but `write(2)`. If the process
// is killed mid-line the worst case is one truncated trailing line, which the
// reader discards.
//
// A record leaves the disk only when the server has it. `drain()` moves the
// queue to `inflight.ndjson` instead of deleting it, and `acknowledge(_:)`
// removes lines after a 2xx. The old reader deleted the file as soon as it was
// read, so a replay that met a dead network was lost for good.

import Foundation
import Darwin

/// A record queued by an earlier run, kept verbatim.
struct SpooledRecord {
    let id: String
    let kind: String
    let json: [String: Any]
}

final class CrashSpool {
    /// Records one run may write through the normal (non-signal) path.
    static let maxRecordsPerRun = 50
    /// And the most a replay carries, newest kept.
    static let maxReplay = 100

    let directory: URL
    private let lock = NSLock()

    var pendingURL: URL { directory.appendingPathComponent("pending.ndjson") }
    var inflightURL: URL { directory.appendingPathComponent("inflight.ndjson") }
    private var installURL: URL { directory.appendingPathComponent("install.id") }

    /// Present while a session is running; absent after a clean shutdown.
    /// Finding one at startup means the previous run did not get to close.
    private var sessionMarkerURL: URL { directory.appendingPathComponent("session.json") }

    /// Set when the directory turns out unusable (read-only, missing, out of
    /// space). The SDK degrades to in-memory rather than throwing on every
    /// single record.
    private(set) var unusable = false

    /// The descriptor every append goes through — including the signal
    /// handler's, which is why it is opened once, up front, and never
    /// replaced: rewriting the file truncates it in place rather than swapping
    /// in a new one the descriptor would not follow.
    private(set) var fd: Int32 = -1

    private var appended = 0
    private var session: [String: Any]?
    private var crashedMarked = false

    init(directory: URL) {
        self.directory = directory
    }

    deinit {
        if fd >= 0 { close(fd) }
    }

    private func ensureDir() -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            return true
        } catch {
            unusable = true
            return false
        }
    }

    /// Open the append descriptor. Called after [drain], so the replay has
    /// already been moved out of the file it will write to.
    @discardableResult
    func open() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard fd < 0, !unusable, ensureDir() else { return fd }
        fd = Darwin.open(pendingURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        if fd < 0 { unusable = true }
        return fd
    }

    // ─── Install id ────────────────────────────────────────────────────────

    func readInstallId() -> String? {
        guard !unusable,
              let text = try? String(contentsOf: installURL, encoding: .utf8)
        else { return nil }
        let id = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    func writeInstallId(_ id: String) {
        guard !unusable, ensureDir() else { return }
        try? id.write(to: installURL, atomically: true, encoding: .utf8)
    }

    // ─── Records ───────────────────────────────────────────────────────────

    /// Queue a record, synchronously and durably. Returns the id that
    /// [acknowledge] removes it with, or nil when it was not written.
    @discardableResult
    func append(kind: String, record: Data) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable, fd >= 0, appended < Self.maxRecordsPerRun else { return nil }
        let id = UUID().uuidString.lowercased()
        var line = Data("{\"id\":\"\(id)\",\"kind\":\"\(jsonEscaped(kind))\",\"record\":".utf8)
        line.append(record)
        line.append(Data("}\n".utf8))
        let ok = line.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            return Darwin.write(fd, base, raw.count) == raw.count
        }
        guard ok else { return nil }
        fsync(fd)
        appended += 1
        return id
    }

    /// Everything earlier runs left behind, including a previous replay the
    /// server never confirmed. Nothing is deleted: the records move to
    /// `inflight.ndjson` until [acknowledge] is called with their ids.
    func drain() -> [SpooledRecord] {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable else { return [] }
        var lines: [Substring] = []
        var sources: [String] = []
        for url in [inflightURL, pendingURL] {
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                sources.append(text)
            }
        }
        for text in sources { lines.append(contentsOf: text.split(separator: "\n")) }
        if lines.isEmpty { return [] }

        var seen = Set<String>()
        var out: [SpooledRecord] = []
        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let kind = obj["kind"] as? String,
                  let record = obj["record"] as? [String: Any]
            else {
                continue // a half-written trailing line from a process that died mid-append
            }
            // Lines from before ids existed get one now; the rewrite below
            // stores it, so acknowledging them works like any other.
            let id = (obj["id"] as? String) ?? UUID().uuidString.lowercased()
            if seen.insert(id).inserted {
                out.append(SpooledRecord(id: id, kind: kind, json: record))
            }
        }
        if out.count > Self.maxReplay { out = Array(out.suffix(Self.maxReplay)) }

        // Inflight first, then empty pending. Dying between the two leaves a
        // record in both, and the id dedupe above folds them back into one.
        writeLines(out, to: inflightURL)
        truncate(pendingURL)
        return out
    }

    /// The server has these (or has refused them for good). Remove them from
    /// wherever they are queued.
    func acknowledge(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !unusable else { return }
        let done = Set(ids)
        for url in [inflightURL, pendingURL] {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            var removed = 0
            var kept: [Substring] = []
            for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
                let id = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["id"] as? String
                if let id, done.contains(id) {
                    removed += 1
                } else {
                    kept.append(line)
                }
            }
            guard removed > 0 else { continue }
            let body = kept.isEmpty ? "" : kept.joined(separator: "\n") + "\n"
            if url == pendingURL {
                // In place: the append descriptor must keep pointing at it.
                rewriteInPlace(url, body)
            } else if kept.isEmpty {
                try? FileManager.default.removeItem(at: url)
            } else {
                try? body.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    private func writeLines(_ records: [SpooledRecord], to url: URL) {
        if records.isEmpty {
            try? FileManager.default.removeItem(at: url)
            return
        }
        var text = ""
        for record in records {
            guard let data = try? JSONSerialization.data(withJSONObject: [
                "id": record.id, "kind": record.kind, "record": record.json,
            ] as [String: Any]),
                let line = String(data: data, encoding: .utf8)
            else { continue }
            text += line + "\n"
        }
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func truncate(_ url: URL) {
        rewriteInPlace(url, "")
    }

    private func rewriteInPlace(_ url: URL, _ body: String) {
        let handle = Darwin.open(url.path, O_WRONLY)
        guard handle >= 0 else { return }
        defer { close(handle) }
        ftruncate(handle, 0)
        let data = Data(body.utf8)
        if !data.isEmpty {
            data.withUnsafeBytes { raw in
                if let base = raw.baseAddress { _ = Darwin.write(handle, base, raw.count) }
            }
        }
        fsync(handle)
    }

    // ─── Sessions ──────────────────────────────────────────────────────────

    /// Mark a session as running. Returns what the previous session left
    /// behind, or nil if it shut down cleanly.
    func beginSession(_ marker: [String: Any]) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable, ensureDir() else { return nil }
        var previous: [String: Any]?
        if FileManager.default.fileExists(atPath: sessionMarkerURL.path) {
            previous = (try? Data(contentsOf: sessionMarkerURL)).flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            } ?? [:]
        }
        writeMarker(marker)
        return previous
    }

    /// Put the marker back for a session that was paused, without treating
    /// it as a previous run.
    func resumeSession(_ marker: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable, ensureDir() else { return }
        writeMarker(marker)
    }

    private func writeMarker(_ marker: [String: Any]) {
        session = marker
        crashedMarked = marker["crashed"] as? Bool == true
        do {
            let data = try JSONSerialization.data(withJSONObject: marker)
            try data.write(to: sessionMarkerURL)
        } catch {
            unusable = true
        }
    }

    /// Note on the live session marker that a fatal error was written — once;
    /// the flag is cached, so a second fatal error costs nothing. The signal
    /// handler cannot do this (it would mean JSON and file replacement in a
    /// dying process); for those, the next launch finds the fatal record that
    /// names the session instead.
    func markSessionCrashed() {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable, !crashedMarked, var marker = session else { return }
        crashedMarked = true
        marker["crashed"] = true
        session = marker
        if let data = try? JSONSerialization.data(withJSONObject: marker) {
            try? data.write(to: sessionMarkerURL)
        }
    }

    /// Record a clean shutdown, so the next launch does not report a crash.
    func endSession() {
        lock.lock()
        defer { lock.unlock() }
        session = nil
        crashedMarked = false
        guard !unusable else { return }
        try? FileManager.default.removeItem(at: sessionMarkerURL)
    }

    /// Test seam.
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        truncate(pendingURL)
        try? FileManager.default.removeItem(at: inflightURL)
        try? FileManager.default.removeItem(at: sessionMarkerURL)
        appended = 0
    }
}
