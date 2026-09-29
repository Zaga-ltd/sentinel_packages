"use strict";
/**
 * Browser SDK — `@sentrinel/plugin/browser`
 *
 * Uncaught errors, failed and slow fetches, breadcrumbs and one session per page
 * load, from a web app.
 *
 * ## No API key here, deliberately
 *
 * Everything in a browser bundle is public. An ingest key shipped to the client
 * is a key anyone can read and use to write into your account, and there is no
 * way to scope it down after the fact. So this SDK holds no key: it posts to a
 * **same-origin endpoint on your own server**, which forwards with the key.
 * `createSentrinelTunnel()` in `@sentrinel/plugin/tunnel` is that endpoint.
 *
 * The tunnel also pins `appName` and `env` server-side, so a page — or anyone
 * who found the endpoint — cannot write telemetry into a different app.
 *
 * ## The join
 *
 * Same-origin fetches get a `traceparent` header, so the backend plugin
 * continues the trace rather than starting a new one: a click and the server
 * work it caused land on one timeline. That is the part worth having. They
 * also carry `x-sentrinel-consumer` and `x-sentrinel-device`, so the backend
 * can attribute a signed-out visitor's requests to the same `guest:` id the
 * page uses.
 *
 * ```ts
 * import { initSentrinelBrowser } from "@sentrinel/plugin/browser";
 *
 * const sentrinel = initSentrinelBrowser({ release: "2026.8.2" });
 * sentrinel.identify("user_123");
 * sentrinel.addBreadcrumb("checkout opened", { category: "ui" });
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ENDPOINT = void 0;
exports.initSentrinelBrowser = initSentrinelBrowser;
exports.getSentrinelBrowser = getSentrinelBrowser;
exports.resetSentrinelBrowser = resetSentrinelBrowser;
exports.loadAnonymousId = loadAnonymousId;
// ─── Types ──────────────────────────────────────────────────────────────────
const replay_1 = require("./replay");
const masking_1 = require("./masking");
// ─── Defaults ───────────────────────────────────────────────────────────────
/**
 * Browser noise that is never actionable.
 *
 * `Script error.` is what a cross-origin script failure looks like with no
 * `crossorigin` attribute — no message, no file, no line. `ResizeObserver loop`
 * is fired by the spec itself and is benign in almost every case. Reporting
 * these buries the errors that mean something.
 */
const DEFAULT_IGNORED = [
    "Script error.",
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    /^Java(Script)? exception occurred/,
    // Browser extensions, not your app.
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
];
const BREADCRUMB_LIMIT = 25;
const MAX_STACK_CHARS = 8000;
const MAX_MESSAGE_CHARS = 2000;
/** Errors have no HTTP method. `varchar(10)`, so this has to stay short. */
const BROWSER_METHOD = "BROWSER";
/** The default tunnel path. See `endpoint` for why not `/api/_sentrinel`. */
exports.DEFAULT_ENDPOINT = "/api/sentrinel";
// ─── Delivery ────────────────────────────────────────────────────────────────
//
// A batch used to be taken out of the buffers — and the session marked sent —
// before the POST, and a failed POST only logged a warning. A server restart,
// a flaky mobile connection or a deploy of the tunnel's host lost the batch
// outright, and a session whose final state failed to send stayed "ok"
// forever. Batches now wait in an outbox until the tunnel answers 2xx, with
// backoff, within these bounds.
/** Batches held while delivery is failing; past this the oldest are dropped. */
const MAX_OUTBOX = 50;
/** …and serialized bytes. */
const MAX_OUTBOX_BYTES = 1024 * 1024;
/** Attempts per batch before it is abandoned. */
const MAX_SEND_ATTEMPTS = 8;
/**
 * Largest body `sendBeacon` and `keepalive` will carry — the spec's 64KB
 * in-flight budget, less headroom. Batches are split to fit, so the ones
 * still waiting when the page is hidden can all leave.
 */
const UNLOAD_BODY_LIMIT = 60000;
// ─── Init ───────────────────────────────────────────────────────────────────
let active = null;
const NOOP = {
    captureError() { },
    addBreadcrumb() { },
    setUser() { },
    identify() { },
    reset() { },
    consumer: "",
    deviceId: "",
    setContext() { },
    track() { },
    page() { },
    async flush() { },
    async close() { },
    enabled: false,
};
/**
 * Start collecting.
 *
 * Safe to call during server rendering: with no `window` it returns a no-op
 * handle rather than throwing, so the same module can be imported from code
 * that runs on both sides.
 *
 * Calling twice returns the first handle instead of double-patching `fetch` —
 * hot reload and React StrictMode both do this routinely.
 */
function initSentrinelBrowser(options = {}) {
    if (typeof window === "undefined" || typeof document === "undefined")
        return NOOP;
    if (active)
        return active;
    active = new BrowserClient(options);
    return active;
}
/** The handle from `initSentrinelBrowser`, or a no-op if it was never called. */
function getSentrinelBrowser() {
    return active ?? NOOP;
}
/** Test seam: forget the singleton so the next init builds a fresh client. */
function resetSentrinelBrowser() {
    active = null;
}
// ─── Client ─────────────────────────────────────────────────────────────────
class BrowserClient {
    /**
     * Vitals arrive on their own schedule, after the session was already sent.
     * LCP is final within seconds, but INP can take a long session to settle —
     * a first flush sends the session with an empty `vitals`, and that must not
     * be the last word. Marking the session unsent (the same trick status
     * changes use) makes the next flush carry the updated numbers.
     */
    noteVitalChange() {
        if (!this.session)
            return;
        if (this.sessionSent) {
            this.sessionSent = false;
            this.maybeFlush();
        }
    }
    constructor(options) {
        this.enabled = true;
        this.errors = [];
        this.requests = [];
        this.breadcrumbs = [];
        this.context = {};
        this.session = null;
        this.sessionSent = false;
        /** Latest observed value of each vital; null until the browser reports one. */
        this.vitals = {};
        /** Buffered product events, drained with everything else. */
        this.events = [];
        /**
         * This device, across sessions.
         *
         * Persisted in localStorage so a returning visitor is recognised as the same
         * device — without it, every visit is a new user and "returning users" is
         * always zero. Falls back to memory where storage is unavailable (private
         * mode, embedded webviews), which degrades to per-session identity rather
         * than throwing.
         */
        this.anonymousId = "";
        this.lastPath = "";
        this.lastPageAt = 0;
        this.timer = null;
        this.originalFetch = null;
        this.teardown = [];
        /** Null until rrweb has loaded, and forever if it cannot. */
        this.replay = null;
        this.closed = false;
        this.warned = new Set();
        /** Batches not yet acknowledged by the tunnel. */
        this.outbox = [];
        this.pumping = null;
        /** Batches abandoned since the last report, so a drop is never silent. */
        this.droppedBatches = 0;
        this.opts = {
            endpoint: exports.DEFAULT_ENDPOINT,
            flushInterval: 10000,
            maxBatch: 100,
            captureRequests: true,
            captureErrors: true,
            captureBreadcrumbs: true,
            trackSessions: true,
            sampleRate: 1,
            slowRequestThresholdMs: 2000,
            debug: false,
            ...options,
        };
        this.ignored = [...DEFAULT_IGNORED, ...(options.ignoreErrors ?? [])];
        this.traceTargets = options.tracePropagationTargets ?? [sameOriginMatcher()];
        this.anonymousId = loadAnonymousId();
        if (this.opts.trackSessions)
            this.startSession();
        if (this.opts.autoPageviews !== false)
            this.installPageviewTracking();
        if (this.opts.captureWebVitals !== false)
            this.installVitalsCollection();
        if (this.opts.replay?.enabled)
            void this.startReplayRecorder();
        if (this.opts.captureErrors)
            this.installErrorHandlers();
        if (this.opts.captureRequests)
            this.patchFetch();
        if (this.opts.captureBreadcrumbs)
            this.installBreadcrumbSources();
        this.installLifecycle();
        this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
        // Never hold the page open on our account (Node/jsdom test envs only).
        this.timer?.unref?.();
    }
    // ── Public API ────────────────────────────────────────────────────────────
    captureError(error, context) {
        this.record(error, { handled: true, context });
    }
    addBreadcrumb(message, options = {}) {
        this.breadcrumbs.push({
            timestamp: new Date().toISOString(),
            message: truncate(message, 500),
            ...options,
        });
        // A trail that grows without bound is a memory leak on a long-lived SPA.
        if (this.breadcrumbs.length > BREADCRUMB_LIMIT) {
            this.breadcrumbs.splice(0, this.breadcrumbs.length - BREADCRUMB_LIMIT);
        }
    }
    /**
     * Who records are attributed to: the identified user, or this device as a
     * guest.
     *
     * Signed-out traffic used to be attributed to nobody (`null`), so a visitor
     * who hit an error before logging in was invisible on the Consumers page
     * and could not be followed across their visits. A `guest:` id names the
     * device rather than a person — the same id the backend receives on
     * `x-sentrinel-consumer`, so both halves attribute to one consumer.
     */
    get consumer() {
        return this.userId ?? `guest:${this.anonymousId}`;
    }
    get deviceId() {
        return this.anonymousId;
    }
    identify(id) {
        this.setUser(id);
    }
    reset() {
        this.setUser(null);
    }
    setUser(id) {
        const previous = this.userId;
        this.userId = id ? String(id) : undefined;
        if (this.session)
            this.session.userId = this.userId;
        // Tell the server this device belongs to this person, so everything the
        // visitor did before logging in can be attributed to them afterwards.
        // Only on a change — SPAs call setUser on every route render.
        if (this.userId && this.userId !== previous) {
            this.events.push({
                kind: "identify",
                name: "identify",
                timestamp: new Date().toISOString(),
                anonymousId: this.anonymousId,
                userId: this.userId,
                sessionId: this.session?.sessionId,
            });
            this.maybeFlush();
        }
    }
    track(name, properties) {
        if (!name || typeof name !== "string")
            return;
        this.events.push({
            kind: "track",
            // A hard slice, not `truncate` — an event name is a grouping key, and a
            // "… [truncated]" suffix would both change the key and read as part of
            // the name everywhere it is displayed.
            name: name.slice(0, 200),
            timestamp: new Date().toISOString(),
            anonymousId: this.anonymousId,
            userId: this.userId,
            sessionId: this.session?.sessionId,
            properties,
            // Ties the event to whatever request it causes, which is what turns
            // "they clicked checkout" into "and here is the query that was slow".
            traceId: this.currentTraceId,
        });
        if (this.session)
            this.session.events = (this.session.events ?? 0) + 1;
        this.maybeFlush();
    }
    page(name, properties) {
        // The search string is where reset tokens and OAuth codes live, and a
        // pageview is stored as-is and shown in lists — masked before it leaves.
        const path = name ??
            (typeof location !== "undefined" ? this.mask(location.pathname + location.search) : "");
        if (!path)
            return;
        // Time on the page just left, measured before the marker is replaced.
        const now = Date.now();
        const duration = this.lastPageAt ? now - this.lastPageAt : 0;
        this.lastPageAt = now;
        this.events.push({
            kind: "pageview",
            name: path.slice(0, 500),
            timestamp: new Date().toISOString(),
            anonymousId: this.anonymousId,
            userId: this.userId,
            sessionId: this.session?.sessionId,
            properties,
            referrer: this.lastPath || (typeof document !== "undefined" ? this.mask(document.referrer ?? "") : ""),
            durationMs: duration > 0 && duration < 3600000 ? duration : 0,
        });
        this.lastPath = path;
        if (this.session)
            this.session.pageviews = (this.session.pageviews ?? 0) + 1;
        this.maybeFlush();
    }
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    async flush() {
        const payload = this.drain();
        if (payload)
            this.enqueue(payload);
        await this.pump();
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.endSession("ok");
        // Newest first. Two installers wrap history.pushState in turn, each saving
        // the function it found; undoing them oldest-first restored the original
        // and then put the second wrapper — which still calls the first — back on
        // top, leaving history patched after close().
        for (const undo of this.teardown.splice(0).reverse()) {
            try {
                undo();
            }
            catch {
                // An unpatch that throws must not stop the rest from being undone.
            }
        }
        await this.flush();
        if (active === this)
            active = null;
    }
    // ── Sessions ──────────────────────────────────────────────────────────────
    startSession() {
        this.session = {
            sessionId: randomId(32),
            status: "ok",
            release: this.opts.release,
            startedAt: new Date().toISOString(),
            userId: this.userId,
            attributes: { platform: "browser", "device.id": this.anonymousId, ...deviceContext() },
        };
    }
    /** A URL with its credential-bearing query values masked. */
    mask(url) {
        return (0, masking_1.maskUrl)(url, this.opts.maskQueryParams);
    }
    /**
     * Raise the session's status, never lower it.
     *
     * A page that crashes and then reports a handled error is still a crash; the
     * ordering of the two events should not change the release's number.
     */
    markSession(status) {
        if (!this.session)
            return;
        const RANK = { ok: 0, errored: 1, abnormal: 2, crashed: 3 };
        if (RANK[status] > RANK[this.session.status]) {
            this.session.status = status;
            this.sessionSent = false; // status changed — worth resending
        }
    }
    endSession(status) {
        if (!this.session)
            return;
        this.markSession(status);
        this.session.endedAt = new Date().toISOString();
        this.sessionSent = false;
    }
    // ── Web vitals ────────────────────────────────────────────────────────────
    //
    // LCP and CLS are "finally settled" metrics: their entries arrive as the
    // value changes, so the observer keeps the *latest* entry of each. INP is
    // the opposite — the worst interaction wins, and an early interaction being
    // slow is the very thing you must not overwrite with a later fast one.
    //
    // Each observer is wrapped so an unsupported entry type throws inside the
    // catch rather than at startup: `layout-shift` needs a recent browser, and
    // the page must not break because one observer is absent.
    installVitalsCollection() {
        if (typeof PerformanceObserver === "undefined")
            return;
        try {
            this.vitalsCollection();
        }
        catch {
            // A throwing observer install must not break the SDK — the rest of the
            // telemetry is worth more than any one vital.
        }
    }
    vitalsCollection() {
        // LCP — largest-contentful-paint, keep the last (it is "largest" until the
        // page is done, so the final candidate is the real one).
        if (PerformanceObserver.supportedEntryTypes?.includes("largest-contentful-paint")) {
            const obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    const lcp = e;
                    if (lcp.startTime > 0)
                        this.vitals.lcp = Math.round(lcp.startTime);
                }
                this.noteVitalChange();
            });
            obs.observe({ type: "largest-contentful-paint", buffered: true });
            this.teardown.push(() => obs.disconnect());
        }
        // CLS — layout-shift, sum of shifts that were not caused by a user input.
        if (PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) {
            let cls = 0;
            const obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    const shift = e;
                    if (!shift.hadRecentInput)
                        cls += shift.value;
                }
                this.vitals.cls = Math.round(cls * 1000) / 1000;
                this.noteVitalChange();
            });
            obs.observe({ type: "layout-shift", buffered: true });
            this.teardown.push(() => obs.disconnect());
        }
        // INP — interaction to next paint, keep the worst interaction. Falls back
        // to first-input on browsers without the `event` entry type.
        const inpType = PerformanceObserver.supportedEntryTypes?.includes("event")
            ? "event"
            : PerformanceObserver.supportedEntryTypes?.includes("first-input")
                ? "first-input"
                : null;
        if (inpType) {
            const obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    const dur = e.duration;
                    if (dur > 0)
                        this.vitals.inp = Math.max(this.vitals.inp ?? 0, Math.round(dur));
                }
                this.noteVitalChange();
            });
            try {
                // `durationThreshold` trims entries too fast to matter, but the TS DOM
                // lib predates it — a cast keeps the perf benefit without lying to the
                // type checker.
                obs.observe({ type: inpType, buffered: true, durationThreshold: 40 });
            }
            catch {
                obs.observe({ type: inpType, buffered: true });
            }
            this.teardown.push(() => obs.disconnect());
        }
    }
    // ── Error capture ─────────────────────────────────────────────────────────
    installErrorHandlers() {
        const onError = (event) => {
            this.record(event.error ?? event.message, {
                handled: false,
                source: event.filename,
                line: event.lineno,
                column: event.colno,
            });
        };
        const onRejection = (event) => {
            this.record(event.reason, { handled: false, mechanism: "unhandledrejection" });
        };
        // addEventListener rather than assigning window.onerror: assignment
        // replaces whatever the app (or another SDK) already installed. Apps run
        // more than one of these, and silently disabling the other one is rude.
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        this.teardown.push(() => window.removeEventListener("error", onError));
        this.teardown.push(() => window.removeEventListener("unhandledrejection", onRejection));
    }
    record(error, meta) {
        const { type, message, stack } = describe(error);
        if (this.isIgnored(message) || (meta.source && this.isIgnored(meta.source))) {
            this.log("ignored:", message);
            return;
        }
        this.markSession(meta.handled ? "errored" : "crashed");
        const record = {
            method: BROWSER_METHOD,
            path: currentPath(),
            // No HTTP exchange happened, so there is no status. 0 says "not a
            // response" instead of inventing a 500 that nobody sent.
            statusCode: 0,
            statusMessage: meta.handled ? "Handled error" : "Unhandled error",
            errorType: type,
            errorMessage: truncate(message, MAX_MESSAGE_CHARS),
            stackTrace: stack ? truncate(stack, MAX_STACK_CHARS) : undefined,
            consumerIdentifier: this.consumer,
            timestamp: new Date().toISOString(),
            attributes: {
                ...this.context,
                ...meta.context,
                "error.handled": meta.handled,
                "error.mechanism": meta.mechanism ?? (meta.handled ? "captureError" : "onerror"),
                "browser.url": this.mask(currentUrl()),
                "device.id": this.anonymousId,
                ...(meta.source ? { "error.source": this.mask(meta.source) } : {}),
                ...(meta.line != null ? { "error.line": meta.line } : {}),
                ...(meta.column != null ? { "error.column": meta.column } : {}),
                ...(this.session ? { "session.id": this.session.sessionId } : {}),
                ...(this.opts.release ? { release: this.opts.release } : {}),
                ...deviceContext(),
                // Sent as structure, not a flattened string — the dashboard renders the
                // trail as a list and needs the fields intact.
                ...(this.breadcrumbs.length ? { breadcrumbs: [...this.breadcrumbs] } : {}),
            },
        };
        const kept = this.applyBeforeSend({ kind: "error", ...record });
        if (!kept)
            return;
        const { kind: _kind, ...rest } = kept;
        this.errors.push(rest);
        // Arms the replay upload. The recorder waits a beat before sending so the
        // frames *after* the failure are included — see ReplayController.onError.
        //
        // No error id is passed because there is not one to pass: occurrence ids
        // are assigned server-side, so the browser has nothing stable to quote.
        // The recording is linked by session id instead, which both sides already
        // agree on, and carries the error's text so the list can say what broke.
        this.replay?.onError(`${rest.errorType ?? "Error"}: ${rest.errorMessage ?? ""}`.trim());
        this.addBreadcrumb(message, { category: "error", level: "error" });
        this.maybeFlush();
    }
    isIgnored(text) {
        return this.ignored.some((p) => typeof p === "string" ? text.includes(p) : p.test(text));
    }
    // ── Request capture ───────────────────────────────────────────────────────
    patchFetch() {
        if (typeof window.fetch !== "function")
            return;
        const original = window.fetch.bind(window);
        this.originalFetch = original;
        const wrapper = async (input, init) => {
            const url = requestUrl(input);
            // Our own batches must not be recorded, or every flush produces a record
            // that triggers the next flush.
            if (this.isOwnEndpoint(url))
                return original(input, init);
            const method = (init?.method ??
                (typeof input === "object" && input && "method" in input ? input.method : "GET")).toUpperCase();
            const started = now();
            const traceId = randomId(32);
            // Kept, not thrown away: it is the parent the backend's span points at, so
            // the click can be put on the trace as the span everything else hangs off.
            const spanId = randomId(16);
            let propagated = false;
            let headers = init?.headers;
            if (this.shouldPropagate(url)) {
                // 01 = sampled. The backend continues this trace rather than starting
                // its own, which is what puts the click and the handler on one waterfall.
                const merged = new Headers(headers ?? (input instanceof Request ? input.headers : undefined));
                if (!merged.has("traceparent")) {
                    merged.set("traceparent", `00-${traceId}-${spanId}-01`);
                    propagated = true;
                }
                // Who is calling, for a backend that cannot tell on its own — a
                // signed-out visitor has no session to resolve. Only ever sent where
                // traceparent is: your own origins, never a third party.
                setHeaderSafely(merged, "x-sentrinel-consumer", this.consumer);
                setHeaderSafely(merged, "x-sentrinel-device", this.anonymousId);
                headers = merged;
                init = { ...init, headers };
            }
            try {
                const response = await original(input, init);
                this.recordRequest({ url, method, status: response.status, started, traceId, spanId: propagated ? spanId : undefined });
                return response;
            }
            catch (err) {
                // A network failure never reached a server, so there is no status.
                this.recordRequest({
                    url,
                    method,
                    status: 0,
                    started,
                    traceId,
                    spanId: propagated ? spanId : undefined,
                    error: err?.message ?? String(err),
                });
                throw err;
            }
        };
        // Carry over anything the environment hung on `fetch` — Bun adds
        // `fetch.preconnect`. Replacing the function without them would quietly
        // remove API that callers may be using.
        const patched = Object.assign(wrapper, window.fetch);
        window.fetch = patched;
        this.teardown.push(() => {
            // Only restore if nobody patched over us in the meantime — clobbering a
            // later SDK's wrapper would silently disable it.
            if (window.fetch === patched && this.originalFetch)
                window.fetch = this.originalFetch;
        });
    }
    isOwnEndpoint(url) {
        try {
            return new URL(url, location.href).pathname === new URL(this.opts.endpoint, location.href).pathname;
        }
        catch {
            return url.includes(this.opts.endpoint);
        }
    }
    /** Same origin as the page, or a target the app said it owns. */
    isFirstParty(url) {
        try {
            if (new URL(url, location.href).origin === location.origin)
                return true;
        }
        catch {
            // Unparseable: fall through to the configured targets.
        }
        return this.shouldPropagate(url);
    }
    shouldPropagate(url) {
        return this.traceTargets.some((t) => (typeof t === "string" ? url.includes(t) : t.test(url)));
    }
    recordRequest(args) {
        const ms = now() - args.started;
        const failed = args.status === 0 || args.status >= 400;
        const slow = ms >= this.opts.slowRequestThresholdMs;
        this.addBreadcrumb(`${args.method} ${pathOf(args.url)}`, {
            category: "http",
            level: failed ? "error" : "info",
            data: { status: args.status, ms: Math.round(ms) },
        });
        // Errors and slow calls always survive sampling — they are the reason
        // anyone opens the page.
        const keep = failed || slow || Math.random() < this.opts.sampleRate;
        if (!keep)
            return;
        const id = randomId(32);
        const query = queryOf(args.url);
        const firstParty = this.isFirstParty(args.url);
        const record = {
            id,
            method: args.method,
            path: pathOf(args.url),
            statusCode: args.status,
            responseTime: Math.round(ms * 100) / 100,
            requestSize: 0,
            responseSize: 0,
            consumerIdentifier: this.consumer,
            queryParams: query ? (0, masking_1.maskQueryParams)(query, this.opts.maskQueryParams) : undefined,
            errorMessage: args.error,
            traceId: args.traceId,
            spanId: args.spanId,
            timestamp: new Date(Date.now() - ms).toISOString(),
            sampleRate: failed || slow ? 1 : this.opts.sampleRate,
            attributes: {
                ...this.context,
                // A timing measured in the browser, not by the server that answered:
                // it includes the network, and must never be averaged into the
                // backend's own numbers for the same route.
                "sentrinel.kind": "client",
                "http.host": hostOf(args.url),
                ...(firstParty ? {} : { "sentrinel.third_party": true }),
                "browser.url": this.mask(currentUrl()),
                "http.url": this.mask(args.url),
                "device.id": this.anonymousId,
                ...(this.session ? { "session.id": this.session.sessionId } : {}),
                ...(this.opts.release ? { release: this.opts.release } : {}),
            },
        };
        const kept = this.applyBeforeSend({ kind: "request", ...record });
        if (!kept)
            return;
        const { kind: _kind, ...rest } = kept;
        this.requests.push(rest);
        if (args.error) {
            this.errors.push({
                method: args.method,
                path: pathOf(args.url),
                statusCode: args.status,
                statusMessage: args.error,
                errorType: "NetworkError",
                errorMessage: truncate(args.error, MAX_MESSAGE_CHARS),
                consumerIdentifier: this.consumer,
                timestamp: new Date().toISOString(),
                traceId: args.traceId,
                // What lets an issue open the exact request that produced it.
                requestLogId: id,
                attributes: {
                    ...this.context,
                    "browser.url": this.mask(currentUrl()),
                    "http.url": this.mask(args.url),
                    "device.id": this.anonymousId,
                },
            });
            this.markSession("errored");
        }
        this.maybeFlush();
    }
    // ── Breadcrumbs ───────────────────────────────────────────────────────────
    installBreadcrumbSources() {
        const onClick = (event) => {
            const target = event.target;
            if (!target?.tagName)
                return;
            this.addBreadcrumb(describeElement(target), { category: "ui.click" });
        };
        document.addEventListener("click", onClick, { capture: true, passive: true });
        this.teardown.push(() => document.removeEventListener("click", onClick, { capture: true }));
        // History is patched rather than listened to because pushState fires no
        // event — an SPA route change would otherwise leave no trace at all.
        let last = currentPath();
        const note = () => {
            const next = currentPath();
            if (next === last)
                return;
            this.addBreadcrumb(`${last} → ${next}`, { category: "navigation" });
            last = next;
        };
        const history = window.history;
        const originalPush = history.pushState;
        const originalReplace = history.replaceState;
        history.pushState = function (...args) {
            const out = originalPush.apply(this, args);
            note();
            return out;
        };
        history.replaceState = function (...args) {
            const out = originalReplace.apply(this, args);
            note();
            return out;
        };
        window.addEventListener("popstate", note);
        this.teardown.push(() => {
            history.pushState = originalPush;
            history.replaceState = originalReplace;
            window.removeEventListener("popstate", note);
        });
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    installLifecycle() {
        // pagehide, not unload: unload is unreliable on mobile Safari and blocks
        // the back/forward cache. This is the last moment guaranteed to run.
        const onHide = () => {
            if (document.visibilityState === "hidden" || !this.session?.endedAt) {
                this.endSession("ok");
            }
            this.flushForUnload();
            // Anything the recorder is still holding. Best-effort: a chunk can be
            // megabytes, which is far past what a beacon will carry, so a recording
            // that only fails at the very last moment may not survive the unload.
            this.replay?.flush();
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden")
                onHide();
        };
        window.addEventListener("pagehide", onHide);
        document.addEventListener("visibilitychange", onVisibility);
        this.teardown.push(() => window.removeEventListener("pagehide", onHide));
        this.teardown.push(() => document.removeEventListener("visibilitychange", onVisibility));
    }
    // ── Sending ───────────────────────────────────────────────────────────────
    /**
     * Pageviews, including the ones a router produces without a navigation.
     *
     * `popstate` alone misses forward navigation, because `pushState` does not
     * fire an event — so both history methods are wrapped. Every SPA framework
     * routes through them, which is why this works without a per-framework
     * integration.
     */
    installPageviewTracking() {
        if (typeof window === "undefined" || typeof history === "undefined")
            return;
        // The initial load.
        this.page();
        const emit = () => {
            // Compared in the same (masked) form page() stores it in.
            const path = this.mask(location.pathname + location.search);
            // A router that re-renders the same route must not count twice.
            if (path === this.lastPath)
                return;
            this.page();
        };
        const originalPush = history.pushState;
        const originalReplace = history.replaceState;
        history.pushState = function (...args) {
            const result = originalPush.apply(this, args);
            queueMicrotask(emit);
            return result;
        };
        history.replaceState = function (...args) {
            const result = originalReplace.apply(this, args);
            queueMicrotask(emit);
            return result;
        };
        window.addEventListener("popstate", emit);
        window.addEventListener("hashchange", emit);
        this.teardown.push(() => {
            history.pushState = originalPush;
            history.replaceState = originalReplace;
            window.removeEventListener("popstate", emit);
            window.removeEventListener("hashchange", emit);
        });
    }
    maybeFlush() {
        if (this.errors.length + this.requests.length + this.events.length >= this.opts.maxBatch) {
            void this.flush();
        }
    }
    drain() {
        const sendSession = this.session && !this.sessionSent;
        if (!this.errors.length && !this.requests.length && !this.events.length && !sendSession) {
            return null;
        }
        const payload = {
            release: this.opts.release,
            errors: this.errors.splice(0),
            requests: this.requests.splice(0),
            events: this.events.splice(0),
            anonymousId: this.anonymousId,
            userId: this.userId,
            sessionId: this.session?.sessionId,
            sessions: sendSession ? [{ ...this.session, vitals: { ...this.vitals } }] : [],
        };
        // Optimistic: set back to false if delivery of this batch fails (see
        // settle()), so the latest session state rides the next batch.
        if (sendSession)
            this.sessionSent = true;
        return payload;
    }
    /** Hold a batch until it is acknowledged, split to fit an unload transport. */
    enqueue(payload) {
        for (const part of splitBatch(payload)) {
            const bytes = safeStringify(part).length;
            this.outbox.push({ payload: part, bytes, attempts: 0, nextAt: 0, inflight: false });
        }
        // Oldest out: in an outage the recent records are the ones worth keeping.
        let total = this.outbox.reduce((n, p) => n + p.bytes, 0);
        while (this.outbox.length > 1 && (this.outbox.length > MAX_OUTBOX || total > MAX_OUTBOX_BYTES)) {
            const i = this.outbox.findIndex((p) => !p.inflight);
            if (i < 0)
                break;
            const [dropped] = this.outbox.splice(i, 1);
            total -= dropped.bytes;
            this.droppedBatches++;
        }
        if (this.droppedBatches) {
            this.warnOnce("outbox", `telemetry could not be delivered to ${this.opts.endpoint} and the backlog is full — ` +
                `dropping the oldest batches.`);
        }
    }
    /**
     * Send what is due, one batch at a time, stopping at the first failure so a
     * dead endpoint is not hammered. Concurrent callers share one run.
     */
    pump() {
        if (this.pumping)
            return this.pumping;
        this.pumping = (async () => {
            try {
                while (true) {
                    const now = Date.now();
                    const next = this.outbox.find((p) => !p.inflight && p.nextAt <= now);
                    if (!next)
                        break;
                    next.inflight = true;
                    const result = await this.post(next.payload, next.bytes, false);
                    next.inflight = false;
                    if (!this.settle(next, result))
                        break;
                }
            }
            finally {
                this.pumping = null;
            }
        })();
        return this.pumping;
    }
    /**
     * Apply a send result to a pending batch. Returns false when delivery is
     * failing and the caller should stop for now.
     */
    settle(pending, result) {
        const remove = () => {
            const i = this.outbox.indexOf(pending);
            if (i >= 0)
                this.outbox.splice(i, 1);
        };
        if (result === "ok") {
            remove();
            return true;
        }
        if (result === "drop") {
            remove();
            this.droppedBatches++;
            return true;
        }
        // Retry, later. A session snapshot is taken out of the held batch and
        // re-armed instead: by the time this batch lands, a newer state (a crash,
        // an end time, final vitals) may exist, and an old snapshot delivered late
        // would overwrite it.
        if (pending.payload.sessions?.length) {
            pending.payload = { ...pending.payload, sessions: [] };
            if (this.session)
                this.sessionSent = false;
        }
        pending.attempts++;
        const empty = !pending.payload.errors.length && !pending.payload.requests.length && !(pending.payload.events?.length ?? 0);
        if (empty) {
            remove();
        }
        else if (pending.attempts >= MAX_SEND_ATTEMPTS) {
            remove();
            this.droppedBatches++;
        }
        else {
            // 2s, 4s, 8s… capped at a minute, jittered so a fleet of tabs that lost
            // the same server does not come back in lockstep.
            const backoff = Math.min(60000, 2000 * 2 ** (pending.attempts - 1));
            pending.nextAt = Date.now() + backoff * (0.5 + Math.random() * 0.5);
        }
        return false;
    }
    /**
     * The page is going away (or hidden, which on mobile is often the last
     * chance): hand every waiting batch to a transport that outlives the page.
     */
    flushForUnload() {
        const payload = this.drain();
        if (payload)
            this.enqueue(payload);
        for (const pending of [...this.outbox]) {
            if (pending.inflight)
                continue;
            // sendBeacon is the only transport a browser guarantees to complete once
            // the page is going away. It has no headers, so it is used only when a
            // tunnel makes them unnecessary. `true` means queued, not delivered —
            // the best a page can know at this point.
            if (this.canBeacon() && pending.bytes <= UNLOAD_BODY_LIMIT) {
                try {
                    const body = safeStringify(pending.payload);
                    if (navigator.sendBeacon(this.opts.endpoint, new Blob([body], { type: "application/json" }))) {
                        this.settle(pending, "ok");
                        continue;
                    }
                }
                catch {
                    // Fall through to a keepalive fetch.
                }
            }
            pending.inflight = true;
            void this.post(pending.payload, pending.bytes, true).then((result) => {
                pending.inflight = false;
                this.settle(pending, result);
            });
        }
    }
    canBeacon() {
        return !this.opts.headers && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function";
    }
    async post(payload, bytes, unloading) {
        const url = this.opts.endpoint;
        const send = this.originalFetch ?? fetch;
        try {
            const res = await send(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(this.opts.headers ?? {}) },
                body: safeStringify(payload),
                // Survives the page navigating away mid-request — within the
                // browser's 64KB budget for such requests.
                keepalive: bytes <= UNLOAD_BODY_LIMIT,
                credentials: "same-origin",
            });
            if (res.ok) {
                this.warned.delete("connect");
                this.warned.delete(String(res.status));
                this.log("sent", payload.errors.length, "errors,", payload.requests.length, "requests");
                return "ok";
            }
            this.warnOnce(String(res.status), `telemetry rejected (${res.status}). Check that ${url} is reachable and that ` +
                `the tunnel's apiKey and env match.`);
            // 408/429/5xx can succeed later; any other 4xx is a request that will
            // be refused the same way every time.
            return res.status === 408 || res.status === 429 || res.status >= 500 ? "retry" : "drop";
        }
        catch (err) {
            if (!unloading)
                this.warnOnce("connect", `cannot reach ${url} — ${err?.message ?? err}`);
            return "retry";
        }
    }
    /**
     * Load rrweb and begin recording.
     *
     * Deliberately not awaited by the constructor: the page should not wait on a
     * dynamic import to become interactive, and a session that errors in the
     * first few hundred milliseconds simply has no recording. That is a better
     * trade than delaying every page load for the few that crash immediately.
     */
    async startReplayRecorder() {
        try {
            this.replay = await (0, replay_1.startReplay)({ debug: this.opts.debug, ...this.opts.replay }, (upload) => void this.sendReplay(upload), () => this.session?.sessionId, () => this.consumer);
            if (this.replay)
                this.teardown.push(() => this.replay?.stop());
        }
        catch (err) {
            this.warnOnce("replay", `session replay failed to start: ${err?.message ?? err}`);
        }
    }
    /**
     * Upload one recording chunk.
     *
     * Its own request rather than part of the telemetry batch: a chunk can be
     * megabytes, and inflating every routine flush with it would delay the small
     * records that are usually the more urgent ones. `keepalive` is deliberately
     * not set — the limit is 64KB, which a recording exceeds immediately, and a
     * request that silently fails that ceiling is worse than a plain one.
     */
    async sendReplay(upload) {
        const send = this.originalFetch ?? fetch;
        // The page URL rides on the chunk and inside rrweb's Meta event — both
        // masked, like every other URL this SDK sends.
        const masked = {
            ...upload,
            url: upload.url ? this.mask(upload.url) : upload.url,
            events: upload.events.map((e) => {
                const data = e.data;
                return typeof data?.href === "string" ? { ...e, data: { ...data, href: this.mask(data.href) } } : e;
            }),
        };
        const body = JSON.stringify({ replay: masked, release: this.opts.release });
        try {
            const res = await send(this.opts.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(this.opts.headers ?? {}) },
                body,
                credentials: "same-origin",
            });
            if (!res.ok) {
                this.warnOnce("replay-send", `replay rejected (${res.status}) by ${this.opts.endpoint}`);
                return;
            }
            this.log("replay chunk sent:", upload.events.length, "events");
        }
        catch (err) {
            this.warnOnce("replay-send", `replay upload failed — ${err?.message ?? err}`);
        }
    }
    applyBeforeSend(record) {
        if (!this.opts.beforeSend)
            return record;
        try {
            return this.opts.beforeSend(record);
        }
        catch (err) {
            // A throwing hook must not swallow the error it was inspecting.
            this.warnOnce("beforeSend", `beforeSend threw: ${err?.message ?? err}`);
            return record;
        }
    }
    warnOnce(key, message) {
        if (this.warned.has(key))
            return;
        this.warned.add(key);
        console.warn(`[sentrinel] ${message}`);
    }
    log(...args) {
        if (this.opts.debug)
            console.log("[sentrinel]", ...args);
    }
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function sameOriginMatcher() {
    if (typeof location === "undefined")
        return /^\//;
    // Relative URLs, or absolute ones on this origin.
    return new RegExp(`^(/(?!/)|${escapeRegExp(location.origin)})`);
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function describe(error) {
    if (error instanceof Error) {
        return { type: error.name || "Error", message: error.message || String(error), stack: error.stack };
    }
    if (typeof error === "string")
        return { type: "Error", message: error };
    if (error && typeof error === "object") {
        const obj = error;
        const message = typeof obj.message === "string" ? obj.message : safeStringify(obj);
        return {
            type: typeof obj.name === "string" ? obj.name : "Error",
            message,
            stack: typeof obj.stack === "string" ? obj.stack : undefined,
        };
    }
    return { type: "Error", message: String(error) };
}
function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Set a header unless the caller already did — and never let it break the
 * app's request. `Headers.set` throws on a value outside ISO-8859-1 (a user id
 * with an accent, say), and a monitoring header must not turn into a failed
 * fetch.
 */
function setHeaderSafely(headers, name, value) {
    if (!value || headers.has(name))
        return;
    if (value.length > 255 || !/^[\x20-\x7e]+$/.test(value))
        return;
    try {
        headers.set(name, value);
    }
    catch {
        // Unsendable value: leave the header off.
    }
}
function hostOf(url) {
    try {
        return new URL(url, typeof location !== "undefined" ? location.href : "http://localhost").host;
    }
    catch {
        return "";
    }
}
/**
 * Split a batch into parts small enough for `sendBeacon`/`keepalive`, by
 * halving its record lists. Sessions and identity ride the first part only
 * (identity on all). A single oversized record is left whole — it can still
 * go by an ordinary fetch while the page is alive.
 */
function splitBatch(payload) {
    if (safeStringify(payload).length <= UNLOAD_BODY_LIMIT)
        return [payload];
    const events = payload.events ?? [];
    const count = payload.errors.length + payload.requests.length + events.length;
    if (count <= 1)
        return [payload];
    const half = (list) => {
        const mid = Math.ceil(list.length / 2);
        return [list.slice(0, mid), list.slice(mid)];
    };
    const [e1, e2] = half(payload.errors);
    const [r1, r2] = half(payload.requests);
    const [v1, v2] = half(events);
    const first = { ...payload, errors: e1, requests: r1, events: v1 };
    const second = { ...payload, errors: e2, requests: r2, events: v2, sessions: [] };
    return [...splitBatch(first), ...splitBatch(second)];
}
function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const text = (el.textContent ?? "").trim().slice(0, 40);
    return `${tag}${id}${cls}${text ? ` "${text}"` : ""}`;
}
function requestUrl(input) {
    if (typeof input === "string")
        return input;
    if (input instanceof URL)
        return input.href;
    return input.url;
}
function pathOf(url) {
    try {
        const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
        return parsed.pathname || "/";
    }
    catch {
        return url.split("?")[0] || "/";
    }
}
function queryOf(url) {
    try {
        const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
        const out = {};
        parsed.searchParams.forEach((v, k) => (out[k] = v));
        return Object.keys(out).length ? out : undefined;
    }
    catch {
        return undefined;
    }
}
function currentPath() {
    return typeof location === "undefined" ? "/" : location.pathname || "/";
}
function currentUrl() {
    return typeof location === "undefined" ? "" : location.href;
}
function deviceContext() {
    if (typeof navigator === "undefined")
        return {};
    const nav = navigator;
    return {
        "browser.language": nav.language,
        "browser.user_agent": nav.userAgent?.slice(0, 300),
        ...(nav.hardwareConcurrency ? { "device.cores": nav.hardwareConcurrency } : {}),
        ...(nav.deviceMemory ? { "device.memory_gb": nav.deviceMemory } : {}),
        ...(nav.connection?.effectiveType ? { "network.type": nav.connection.effectiveType } : {}),
        ...(typeof screen !== "undefined"
            ? { "screen.size": `${screen.width}x${screen.height}` }
            : {}),
    };
}
function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
const HEX = "0123456789abcdef";
function randomId(length) {
    const bytes = new Uint8Array(length / 2);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    }
    else {
        for (let i = 0; i < bytes.length; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = "";
    for (const b of bytes)
        out += HEX[b >> 4] + HEX[b & 15];
    return out;
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}
// ─── Device identity ─────────────────────────────────────────────────────────
const ANON_KEY = "sentrinel_anonymous_id";
/**
 * A stable id for this browser.
 *
 * Persisted so a returning visitor is the same device — without it every visit
 * is a new user and "returning" is permanently zero. localStorage throws in
 * some embedded webviews and in Safari private mode, so failure falls back to
 * a per-session id rather than propagating.
 *
 * Deliberately not a fingerprint: no canvas hashing, no IP+UA composite.
 * Someone who clears their storage becomes a new visitor, which is the answer
 * they asked for by clearing it.
 */
function loadAnonymousId() {
    const fresh = `anon_${randomId(24)}`;
    try {
        if (typeof localStorage === "undefined")
            return fresh;
        const existing = localStorage.getItem(ANON_KEY);
        if (existing && /^anon_[A-Za-z0-9_-]{8,}$/.test(existing))
            return existing;
        localStorage.setItem(ANON_KEY, fresh);
        return fresh;
    }
    catch {
        return fresh;
    }
}
