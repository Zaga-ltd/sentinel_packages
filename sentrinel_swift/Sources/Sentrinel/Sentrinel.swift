// ─── Sentrinel for iOS / macOS ──────────────────────────────────────────────
//
// Native crash reporting and release health. Posts the same error and session
// shapes the Flutter SDK sends, so native crashes and Dart crashes land in the
// same issues, sessions and release-health pages.
//
// ```swift
// Sentrinel.start(options: .init(
//     serverUrl: URL(string: "https://api.sentrinel.dev")!,
//     appName: "mobile-app",
//     env: "prod",
//     apiKey: "<a Mobile key>",
//     release: "1.4.2"
// ))
// Sentrinel.identify(user.id)   // after sign-in; nil on sign-out
// ```
//
// After `start`, uncaught ObjC exceptions and fatal signals (including Swift
// traps) are written to disk as they happen and delivered on the next launch.
// `captureError` reports handled errors; `addBreadcrumb` leaves a trail. On iOS
// the session ends and everything is flushed when the app is backgrounded.
//
// What this SDK does not do (yet): tracing, `traceparent`, product events,
// custom metrics, or a `beforeSend` hook. Those are in the Flutter/Dart SDK.
//
// `storagePath` defaults to the app's Application Support directory. On macOS
// set it explicitly in a sandboxed app, or pass `nil` to keep crashes in
// memory only.

import Foundation

#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

public final class Sentrinel {
    private static let lock = NSRecursiveLock()
    private static var collector: Collector?
    private static var spool: CrashSpool?
    private static var persistCrashes = false
    private static var consumerOverride: String?
    private static var userId: String?
    private static var installId: String?
    private static var device: [String: Any] = [:]
    private static var deviceType = "mobile"
    private static var context: [String: Any] = [:]
    private static var crumbs = BreadcrumbTrail()
    private static var appName = ""
    private static var env = "prod"
    private static var release: String?
    private static var sessionId: String?
    private static var sessionStartedAt: Date?
    private static var sessionStatus = "ok"
    private static var backgroundedAt: Date?
    private static var observers: [NSObjectProtocol] = []

    private init() {}

    /// How long the app may sit in the background and still be the same
    /// session when it returns. Past it, returning starts a new one.
    public static var sessionTimeout: TimeInterval = 30

    /// True once [start] has been called. Every other call is a no-op until
    /// then, so a missing init degrades to "no telemetry" rather than a crash.
    public static var isStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return collector != nil
    }

    /// Set when the previous run ended without a clean shutdown.
    ///
    /// Killed by the OS in the foreground, force-quit and hard crash all look
    /// identical from inside the next launch — this is the honest definition.
    public private(set) static var previousRunCrashed = false

    public struct Options {
        public var serverUrl: URL
        public var appName: String
        public var env: String
        public var apiKey: String?
        /// Which part of the project this is — "ios", "watch". An app is the
        /// whole project; the phone reports as a module of it beside the
        /// backend. Nil uses the API key's name.
        public var module: String?
        /// The build this is — a version name, a git SHA. Crash-free rate is
        /// per release; without it every build is "unknown".
        public var release: String?
        public var flushInterval: TimeInterval
        /// Pins the consumer to a fixed value — a tenant, a kiosk — until
        /// `identify` replaces it. Usually leave it nil: signed-out traffic is
        /// `guest:<install id>`, and `identify(user.id)` names the person.
        public var consumerIdentifier: String?
        /// Where crash reports and the install id wait between launches.
        /// Defaults to the app's Application Support directory. Nil keeps
        /// everything in memory.
        public var storagePath: URL?
        /// Write fatal errors to disk so they survive the process. Off, a
        /// fatal error is sent straight away and a real crash is lost.
        public var persistCrashes: Bool
        /// Install the NSException and signal handlers. On by default; off
        /// leaves crash capture to another reporter.
        public var installCrashHandlers: Bool
        /// End the session and flush when an iOS app is backgrounded; resume or
        /// start a new one when it returns.
        public var trackLifecycle: Bool

        /// Test seam: a configuration with a stub protocol.
        var urlSessionConfiguration: URLSessionConfiguration?

        public init(
            serverUrl: URL,
            appName: String,
            env: String = "prod",
            apiKey: String? = nil,
            module: String? = nil,
            release: String? = nil,
            flushInterval: TimeInterval = 30,
            consumerIdentifier: String? = nil,
            storagePath: URL? = Sentrinel.defaultStoragePath,
            persistCrashes: Bool = true,
            installCrashHandlers: Bool = true,
            trackLifecycle: Bool = true
        ) {
            self.serverUrl = serverUrl
            self.appName = appName
            self.env = env
            self.apiKey = apiKey
            self.module = module
            self.release = release
            self.flushInterval = flushInterval
            self.consumerIdentifier = consumerIdentifier
            self.storagePath = storagePath
            self.persistCrashes = persistCrashes
            self.installCrashHandlers = installCrashHandlers
            self.trackLifecycle = trackLifecycle
        }
    }

    /// Default storage: the app's Application Support directory. Survives app
    /// updates and relaunches; the OS does not clear it the way it does caches.
    public static var defaultStoragePath: URL? {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent("sentrinel", isDirectory: true)
    }

    public static func start(options: Options) {
        lock.lock()
        defer { lock.unlock() }

        // Starting again replaces the collector. The old one's buffer is sent
        // and its session closed cleanly, not reported as abnormal by the new.
        if let old = collector {
            endSession(on: old)
            old.stop()
        }

        let pinned = options.consumerIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        consumerOverride = (pinned?.isEmpty ?? true) ? nil : pinned
        userId = nil
        device = Device.context
        deviceType = Device.deviceType
        release = options.release
        appName = options.appName
        env = options.env
        crumbs = BreadcrumbTrail()
        persistCrashes = options.persistCrashes
        backgroundedAt = nil

        let spool = options.storagePath.map { CrashSpool(directory: $0) }
        Self.spool = spool
        installId = resolveInstallId(spool)

        let collector = Collector(
            serverUrl: options.serverUrl,
            appName: options.appName,
            env: options.env,
            apiKey: options.apiKey,
            module: options.module,
            flushInterval: options.flushInterval,
            userAgent: Device.userAgent(deviceType: deviceType),
            configuration: options.urlSessionConfiguration
        )
        collector.onDelivered = { ids in spool?.acknowledge(ids) }
        Self.collector = collector

        var replay: [SpooledRecord] = []
        if persistCrashes, let spool {
            // Drained before the append descriptor opens, so the replay has
            // left the file the crash handler writes to.
            replay = spool.drain()
            let fd = spool.open()
            if fd >= 0 { CrashHandler.prepare(fd: fd) }
        }
        openSession(collector, replay: replay)
        for record in replay {
            // Replayed as-is: serialised at crash time, timestamps from then.
            collector.recordRaw(kind: record.kind, json: record.json, spoolId: record.id)
        }
        if !replay.isEmpty { collector.flush() }

        renderCrashTemplate()
        if options.installCrashHandlers, persistCrashes, spool?.fd ?? -1 >= 0 {
            CrashHandler.install()
        }
        if options.trackLifecycle { observeLifecycle() }
    }

    // ─── Identity ──────────────────────────────────────────────────────────

    /// This install's id: the same across launches, different on every device.
    /// Every error carries it as `device.id`, and it is the `guest:` consumer
    /// while nobody is signed in.
    public static var deviceId: String? {
        lock.lock()
        defer { lock.unlock() }
        return installId
    }

    /// Who errors and sessions are filed under: the signed-in user after
    /// `identify`, `guest:<install id>` before it, or a pinned value.
    public static var consumer: String? {
        lock.lock()
        defer { lock.unlock() }
        return currentConsumer
    }

    private static var currentConsumer: String? {
        consumerOverride ?? userId ?? installId.map { "guest:\($0)" }
    }

    /// Attach a real identity to everything from here on.
    ///
    /// Call it after sign-in, at launch when a saved session is restored, and
    /// after profile updates. `nil` signs them out: traffic returns to
    /// `guest:<install id>`. It also clears a consumer pinned with
    /// `setConsumer` or `consumerIdentifier`.
    public static func identify(_ userId: String?) {
        lock.lock()
        let trimmed = userId?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.userId = (trimmed?.isEmpty ?? true) ? nil : trimmed
        consumerOverride = nil
        lock.unlock()
        renderCrashTemplate()
    }

    /// Pin the consumer to something that is not the signed-in user — a
    /// tenant, a kiosk. `nil` un-pins it.
    public static func setConsumer(_ identifier: String?) {
        lock.lock()
        let trimmed = identifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        consumerOverride = (trimmed?.isEmpty ?? true) ? nil : trimmed
        lock.unlock()
        renderCrashTemplate()
    }

    @available(*, deprecated, renamed: "identify")
    public static func setUser(_ id: String?) {
        identify(id)
    }

    /// Headers for requests to **your own** backend, so its Sentrinel SDK
    /// files server-side errors under the same person and install. Never add
    /// them to third-party requests.
    ///
    /// ```swift
    /// for (name, value) in Sentrinel.identityHeaders {
    ///     request.setValue(value, forHTTPHeaderField: name)
    /// }
    /// ```
    public static var identityHeaders: [String: String] {
        lock.lock()
        defer { lock.unlock() }
        var headers: [String: String] = [:]
        if let consumer = currentConsumer { headers["x-sentrinel-consumer"] = consumer }
        if let installId { headers["x-sentrinel-device"] = installId }
        return headers
    }

    private static func resolveInstallId(_ spool: CrashSpool?) -> String {
        if let existing = spool?.readInstallId() { return existing }
        let defaultsKey = "dev.sentrinel.install-id"
        if spool == nil || spool?.unusable == true,
           let saved = UserDefaults.standard.string(forKey: defaultsKey) {
            return saved
        }
        let fresh = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        if let spool, !spool.unusable {
            spool.writeInstallId(fresh)
        } else {
            UserDefaults.standard.set(fresh, forKey: defaultsKey)
        }
        return fresh
    }

    // ─── Recording ─────────────────────────────────────────────────────────

    /// Report an error. Non-fatal by default: sent on the next flush and the
    /// session marked `errored`. `fatal: true` means the process is about to
    /// die — the report is written to disk before this returns, sent now too,
    /// and the session marked `crashed`.
    public static func captureError(
        _ error: Error,
        path: String = "app",
        attributes: [String: Any]? = nil,
        fatal: Bool = false,
        mechanism: String? = nil
    ) {
        capture(
            errorType: String(describing: Swift.type(of: error)),
            errorMessage: error.localizedDescription,
            stack: Thread.callStackSymbols.joined(separator: "\n"),
            path: path,
            attributes: attributes,
            fatal: fatal,
            mechanism: mechanism
        )
    }

    /// Leave a marker describing something the app just did. Attached to every
    /// error reported afterwards, crashes included.
    public static func addBreadcrumb(_ message: String, category: String = "app", data: [String: Any]? = nil) {
        lock.lock()
        crumbs.add(Breadcrumb(category: category, message: message, data: data))
        lock.unlock()
        renderCrashTemplate()
    }

    /// Fields attached to every subsequent record — screen, user tier, build.
    public static func setContext(_ fields: [String: Any]) {
        lock.lock()
        for (key, value) in fields { context[key] = value }
        lock.unlock()
        renderCrashTemplate()
    }

    /// Send whatever is buffered now. The call for backgrounding — it does not
    /// end anything. [completion] runs once every post has answered.
    public static func flush(completion: (() -> Void)? = nil) {
        lock.lock()
        let collector = self.collector
        lock.unlock()
        guard let collector else {
            completion?()
            return
        }
        collector.flush(completion: completion)
    }

    /// Shut down for good — app termination, not backgrounding. Ends the
    /// session cleanly, sends what is buffered (waiting up to [timeout]
    /// seconds, since the process is about to exit), and stops. Safe to call
    /// twice; every call after the first is a no-op.
    public static func close(timeout: TimeInterval = 2) {
        lock.lock()
        guard let collector else {
            lock.unlock()
            return
        }
        self.collector = nil
        if backgroundedAt == nil { endSession(on: collector) }
        removeLifecycleObservers()
        sessionId = nil
        sessionStartedAt = nil
        lock.unlock()

        let done = DispatchSemaphore(value: 0)
        collector.stop { done.signal() }
        _ = done.wait(timeout: .now() + timeout)
    }

    /// Test seam: the process dies. No session end, no final flush, the marker
    /// and the spool left exactly as they are.
    static func abandonForTesting() {
        lock.lock()
        let collector = self.collector
        self.collector = nil
        removeLifecycleObservers()
        sessionId = nil
        sessionStartedAt = nil
        lock.unlock()
        collector?.abandon()
    }

    // ─── Sessions ──────────────────────────────────────────────────────────

    private static func marker() -> [String: Any] {
        var marker: [String: Any] = [
            "sessionId": sessionId ?? "",
            "startedAt": ErrorRecord.iso(sessionStartedAt ?? Date()),
            "appName": appName,
            "env": env,
            "crashed": sessionStatus == "crashed",
        ]
        if let release { marker["release"] = release }
        if let consumer = currentConsumer { marker["distinctId"] = consumer }
        return marker
    }

    private static func sessionRecord(durationMs: Double? = nil) -> SessionRecord? {
        guard let sessionId, let sessionStartedAt else { return nil }
        return SessionRecord(
            sessionId: sessionId,
            status: sessionStatus,
            startedAt: sessionStartedAt,
            release: release,
            distinctId: currentConsumer,
            deviceOs: Device.osName,
            deviceOsVersion: Device.osVersion,
            durationMs: durationMs
        )
    }

    /// Record that this run started, and notice if the last one never finished.
    private static func openSession(_ collector: Collector, replay: [SpooledRecord]) {
        sessionId = UUID().uuidString.lowercased()
        sessionStartedAt = Date()
        sessionStatus = "ok"
        let previous = persistCrashes ? spool?.beginSession(marker()) : nil
        if let record = sessionRecord() { collector.recordSession(record) }

        previousRunCrashed = previous != nil
        guard let previous else { return }

        // The previous session left its marker, so it did not shut down
        // cleanly. With a crash report it is `crashed`; without, `abnormal`.
        // A signal handler cannot flip the marker, so a fatal record that
        // names the session counts as the report.
        let previousId = previous["sessionId"] as? String
        let crashed = previous["crashed"] as? Bool == true || replay.contains { record in
            let attrs = record.json["attributes"] as? [String: Any]
            return attrs?["sentrinel.fatal"] as? Bool == true
                && previousId != nil
                && attrs?["session.id"] as? String == previousId
        }
        collector.recordSession(SessionRecord(
            sessionId: (previousId?.isEmpty == false ? previousId : nil) ?? UUID().uuidString.lowercased(),
            status: crashed ? "crashed" : "abnormal",
            startedAt: (previous["startedAt"] as? String).flatMap { ErrorRecord.isoFormatter.date(from: $0) } ?? Date(),
            release: previous["release"] as? String,
            // The owner the marker recorded, or none — the server keeps the
            // one it has. Not whoever launched the app this time.
            distinctId: previous["distinctId"] as? String,
            deviceOs: Device.osName,
            deviceOsVersion: Device.osVersion
        ))
    }

    private static func endSession(on collector: Collector) {
        guard let started = sessionStartedAt,
              let record = sessionRecord(durationMs: Date().timeIntervalSince(started) * 1000)
        else { return }
        collector.recordSession(record)
        if persistCrashes { spool?.endSession() }
    }

    private static func worsenSession(_ status: String) {
        let rank = ["ok": 0, "errored": 1, "crashed": 3]
        guard (rank[status] ?? 0) > (rank[sessionStatus] ?? 0) else { return }
        sessionStatus = status
        if let record = sessionRecord() { collector?.recordSession(record) }
    }

    /// The app went to the background: end the session with its duration and
    /// flush, holding a background activity open until the posts answer. The
    /// OS kills backgrounded apps without notice; ending first is what keeps
    /// that from being reported as `abnormal` on the next launch.
    public static func didEnterBackground() {
        lock.lock()
        guard let collector, backgroundedAt == nil else {
            lock.unlock()
            return
        }
        backgroundedAt = Date()
        endSession(on: collector)
        lock.unlock()

        #if os(macOS)
        // A backgrounded Mac app keeps running; an ordinary flush is enough.
        collector.flush()
        #else
        // Holds the process awake until the posts answer. Unlike
        // `UIApplication.beginBackgroundTask`, this is allowed in app
        // extensions too.
        let done = DispatchSemaphore(value: 0)
        ProcessInfo.processInfo.performExpiringActivity(withReason: "sentrinel.flush") { expired in
            if expired { done.signal(); return }
            collector.flush { done.signal() }
            _ = done.wait(timeout: .now() + 10)
        }
        #endif
    }

    /// The app came back: the same session within [sessionTimeout], a new one
    /// after.
    public static func willEnterForeground() {
        lock.lock()
        defer { lock.unlock() }
        guard let since = backgroundedAt, let collector else { return }
        backgroundedAt = nil
        if Date().timeIntervalSince(since) >= sessionTimeout {
            openSession(collector, replay: [])
        } else if persistCrashes {
            spool?.resumeSession(marker())
        }
        renderCrashTemplateLocked()
    }

    private static func observeLifecycle() {
        removeLifecycleObservers()
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
                didEnterBackground()
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in
                willEnterForeground()
            },
            center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in
                close()
            },
        ]
        #endif
    }

    private static func removeLifecycleObservers() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private static func baseAttributes() -> [String: Any] {
        var attrs = device
        for (key, value) in context { attrs[key] = value }
        if let installId { attrs["device.id"] = installId }
        if let sessionId { attrs["session.id"] = sessionId }
        if let release { attrs["release"] = release }
        if crumbs.count > 0 { attrs["breadcrumbs"] = crumbs.json }
        return attrs
    }

    private static func capture(
        errorType: String,
        errorMessage: String,
        stack: String?,
        path: String,
        attributes: [String: Any]?,
        fatal: Bool,
        mechanism: String?
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard let collector else { return }

        var attrs = baseAttributes()
        if let attributes { for (key, value) in attributes { attrs[key] = value } }
        if let mechanism { attrs["sentrinel.mechanism"] = mechanism }
        attrs["sentrinel.handled"] = !fatal
        if fatal { attrs["sentrinel.fatal"] = true }

        let record = ErrorRecord(
            path: fatal ? "app/crash" : path,
            errorType: errorType,
            errorMessage: errorMessage,
            stackTrace: stack,
            consumerIdentifier: currentConsumer,
            attributes: attrs
        )
        guard let data = try? makeEncoder().encode(record) else { return }

        if fatal {
            // On disk first. If the app dies on the next line the report still
            // ships on the next launch; if it lives, the send below removes
            // the disk copy once the server has it.
            var spoolId: String?
            if persistCrashes, let spool {
                spoolId = spool.append(kind: "error", record: data)
                spool.markSessionCrashed()
            }
            worsenSession("crashed")
            collector.recordEncodedError(data, spoolId: spoolId)
            collector.flush()
        } else {
            collector.recordEncodedError(data)
            worsenSession("errored")
        }
    }

    private static func renderCrashTemplate() {
        lock.lock()
        defer { lock.unlock() }
        renderCrashTemplateLocked()
    }

    /// Pre-render the record the signal handler will write, so the handler
    /// itself only copies bytes. Re-rendered whenever what it would say
    /// changes; falls back to fewer breadcrumbs, then none, if it grows past
    /// the buffer.
    private static func renderCrashTemplateLocked() {
        guard collector != nil, persistCrashes, sentrinelTemplates != nil else { return }
        var attrs = baseAttributes()
        attrs["sentrinel.fatal"] = true
        attrs["sentrinel.handled"] = false
        if let image = sentrinelMainImage() {
            attrs["sentrinel.image_name"] = image.name
            attrs["sentrinel.image_base"] = image.base
        }
        for attempt in 0..<3 {
            if attempt == 1 { attrs["breadcrumbs"] = (attrs["breadcrumbs"] as? [[String: Any]])?.suffix(5).map { $0 } }
            if attempt == 2 { attrs.removeValue(forKey: "breadcrumbs") }
            if let prefix = crashPrefix(attrs), prefix.count + 4096 <= sentrinelScratchCapacity {
                CrashHandler.setTemplate(prefix)
                return
            }
        }
    }

    /// `{"id":…,"kind":"error","record":{…,"attributes":{…,"sentrinel.mechanism":"`
    /// — the handler appends the mechanism and the rest.
    static func crashPrefix(_ attrs: [String: Any]) -> Data? {
        var head: [String: Any] = ["method": "APP", "path": "app/crash", "statusCode": 500]
        if let consumer = currentConsumer { head["consumerIdentifier"] = consumer }
        guard var record = try? JSONSerialization.data(withJSONObject: head),
              var attributes = try? makeEncoder().encode(AttributesValue(attrs)),
              record.last == UInt8(ascii: "}"), attributes.last == UInt8(ascii: "}")
        else { return nil }
        record.removeLast()
        attributes.removeLast()
        var out = Data("{\"id\":\"\(UUID().uuidString.lowercased())\",\"kind\":\"error\",\"record\":".utf8)
        out.append(record)
        out.append(Data(",\"attributes\":".utf8))
        out.append(attributes)
        if attributes.count > 1 { out.append(UInt8(ascii: ",")) }
        out.append(Data("\"sentrinel.mechanism\":\"".utf8))
        return out
    }
}
