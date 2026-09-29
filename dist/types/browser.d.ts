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
import { type ReplayOptions, type ReplayUpload } from "./replay.js";
export type { ReplayOptions } from "./replay.js";
export interface SentrinelBrowserOptions {
    /**
     * Where batches are posted. `/api/sentrinel` — same-origin — by default,
     * which is what keeps the ingest key on your server. Point it at the ingest
     * API directly only if you accept that the key in `headers` becomes public.
     *
     * Not `/api/_sentrinel`, the old default: Next's App Router treats a folder
     * starting with `_` as private and never routes to it, so the default could
     * not be served by the framework it was most often used with.
     */
    endpoint?: string;
    /**
     * Extra query keys to mask in every URL the SDK records. Added to a
     * built-in list that always applies — reset and magic-link tokens, OAuth
     * `code`, `api_key`, signed-URL signatures — because a page URL is exactly
     * where those turn up.
     */
    maskQueryParams?: (string | RegExp)[];
    /** Build identifier. Without it, release health cannot tell builds apart. */
    release?: string;
    /**
     * Only needed when posting straight at the ingest API rather than a tunnel.
     * Anything here ships in the bundle.
     */
    headers?: Record<string, string>;
    /**
     * Which requests get a `traceparent`. Same-origin only by default: sending
     * trace headers to a third party leaks your ids, and usually trips CORS
     * preflight on a request that was previously simple.
     */
    tracePropagationTargets?: (string | RegExp)[];
    /** How often a batch leaves, in ms. */
    flushInterval?: number;
    /**
     * Capture a pageview automatically on load and on every SPA route change.
     *
     * On by default. A router that changes the URL without a navigation is the
     * normal case in React/Vue/Svelte, and a pageview count that only counts
     * hard loads reports a single-page app as a single page.
     */
    autoPageviews?: boolean;
    /** Records held before an early flush. */
    maxBatch?: number;
    /** Patch `fetch` to record calls and propagate the trace. */
    captureRequests?: boolean;
    /** `window.onerror` and `unhandledrejection`. */
    captureErrors?: boolean;
    /** Clicks, navigations and requests, kept as a trail on each error. */
    captureBreadcrumbs?: boolean;
    /** One session per page load — the denominator for crash-free rate. */
    trackSessions?: boolean;
    /**
     * Collect the Core Web Vitals a browser can observe — LCP, CLS and INP — and
     * attach them to the session. Off by default? No — on by default, but only
     * where `PerformanceObserver` exists, which is every supported browser since
     * 2021. A no-op on browsers without it.
     */
    captureWebVitals?: boolean;
    /** Messages matching any of these are dropped before they are recorded. */
    ignoreErrors?: (string | RegExp)[];
    /** Fraction of successful requests kept. Errors and slow calls are never sampled out. */
    sampleRate?: number;
    /** Above this, a request is kept regardless of `sampleRate`. */
    slowRequestThresholdMs?: number;
    /** Last chance to redact or drop a record. Return `null` to drop it. */
    beforeSend?: (record: BrowserRecord) => BrowserRecord | null;
    /**
     * Session replay. Off unless `enabled` is set.
     *
     * Records the DOM and uploads only the seconds leading up to an error, out of
     * a rolling in-memory buffer — see replay.ts for why buffering rather than
     * streaming. Requires `rrweb` to be installed; it is imported dynamically, so
     * leaving this off costs nothing in the bundle.
     */
    replay?: ReplayOptions;
    /** Log what the SDK is doing to the console. */
    debug?: boolean;
}
export type BrowserRecord = ({
    kind: "error";
} & BrowserError) | ({
    kind: "request";
} & BrowserRequest);
export interface BrowserError {
    method: string;
    path: string;
    statusCode: number;
    statusMessage: string;
    errorType?: string;
    errorMessage?: string;
    stackTrace?: string;
    consumerIdentifier?: string | null;
    timestamp: string;
    traceId?: string;
    requestLogId?: string;
    attributes?: Record<string, unknown>;
}
export interface BrowserRequest {
    id: string;
    method: string;
    path: string;
    statusCode: number;
    responseTime: number;
    requestSize: number;
    responseSize: number;
    consumerIdentifier?: string | null;
    queryParams?: Record<string, string>;
    errorMessage?: string;
    traceId?: string;
    /**
     * The span id in the traceparent this page sent: the parent the backend's span
     * continues. Present only when the SDK set the header itself.
     */
    spanId?: string;
    attributes?: Record<string, unknown>;
    timestamp: string;
    sampleRate?: number;
}
export interface BrowserSession {
    sessionId: string;
    status: "ok" | "crashed" | "abnormal" | "errored";
    release?: string;
    startedAt: string;
    endedAt?: string;
    userId?: string;
    attributes?: Record<string, unknown>;
    /**
     * Core Web Vitals for this page load, when the browser could measure them.
     *
     * `lcp` and `inp` are milliseconds; `cls` is a unitless cumulative score.
     * One entry per session, sent with the session — vitals are a page-load
     * property, not a per-error one, and attaching them to errors would inflate
     * nothing but the payloads.
     */
    vitals?: {
        lcp?: number;
        cls?: number;
        inp?: number;
    };
    /** Counted client-side so a session row carries its own totals. */
    pageviews?: number;
    events?: number;
}
export interface Breadcrumb {
    timestamp: string;
    message: string;
    category?: string;
    level?: "debug" | "info" | "warning" | "error";
    data?: Record<string, unknown>;
}
export interface SentrinelBrowser {
    /** Report a handled error. Marks the session `errored`. */
    captureError(error: unknown, context?: Record<string, unknown>): void;
    /** Leave a note on the trail that every later error carries. */
    addBreadcrumb(message: string, options?: Omit<Breadcrumb, "timestamp" | "message">): void;
    /**
     * Who this is, so errors group by person on the Consumers page. Until it is
     * called — and after `null` — records are attributed to `guest:<device id>`.
     */
    setUser(id: string | null | undefined): void;
    /**
     * Switch attribution to this user, and link this device's guest history to
     * them. `identify(null)` goes back to the guest id. Same as `setUser`.
     */
    identify(id: string | null | undefined): void;
    /** Sign-out: back to the guest id. The device id itself is kept. */
    reset(): void;
    /** Who records are attributed to right now: the user, or `guest:<device id>`. */
    readonly consumer: string;
    /** This browser's persisted anonymous id. */
    readonly deviceId: string;
    /** Key/values attached to everything sent from here on. */
    setContext(context: Record<string, unknown>): void;
    /**
     * Record a product event.
     *
     * `track("checkout_started", { plan: "pro" })`. Properties are flat
     * key/values — nested objects are stringified server-side rather than walked,
     * so flatten anything you intend to filter on.
     */
    track(name: string, properties?: Record<string, unknown>): void;
    /**
     * Record a page view explicitly.
     *
     * Only needed when `autoPageviews` is off, or for a virtual page a router
     * does not produce a URL for.
     */
    page(name?: string, properties?: Record<string, unknown>): void;
    /** Send what is buffered now. */
    flush(): Promise<void>;
    /** Unpatch, end the session, send the last batch. */
    close(): Promise<void>;
    /** False when running on the server, where this is a no-op. */
    readonly enabled: boolean;
}
/** The default tunnel path. See `endpoint` for why not `/api/_sentrinel`. */
export declare const DEFAULT_ENDPOINT = "/api/sentrinel";
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
export declare function initSentrinelBrowser(options?: SentrinelBrowserOptions): SentrinelBrowser;
/** The handle from `initSentrinelBrowser`, or a no-op if it was never called. */
export declare function getSentrinelBrowser(): SentrinelBrowser;
/** Test seam: forget the singleton so the next init builds a fresh client. */
export declare function resetSentrinelBrowser(): void;
export interface BrowserEvent {
    kind: "pageview" | "screen" | "track" | "identify";
    name: string;
    timestamp: string;
    anonymousId?: string;
    userId?: string;
    sessionId?: string;
    properties?: Record<string, unknown>;
    referrer?: string;
    traceId?: string;
    durationMs?: number;
}
export interface BatchPayload {
    release?: string;
    errors: BrowserError[];
    requests: BrowserRequest[];
    sessions: BrowserSession[];
    /** Product events — pageviews, screens, track() calls. */
    events?: BrowserEvent[];
    /** Batch-level identity, so per-event repetition stays optional. */
    anonymousId?: string;
    userId?: string;
    sessionId?: string;
    /**
     * A session-replay chunk, when this request is carrying one.
     *
     * Replay posts to the same endpoint as everything else so that one
     * same-origin tunnel keeps the ingest key off the page — but in its own
     * request, so a multi-megabyte recording never rides along with the small
     * records.
     */
    replay?: ReplayUpload;
}
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
export declare function loadAnonymousId(): string;
