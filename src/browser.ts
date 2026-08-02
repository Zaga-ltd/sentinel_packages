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
 * work it caused land on one timeline. That is the part worth having.
 *
 * ```ts
 * import { initSentrinelBrowser } from "@sentrinel/plugin/browser";
 *
 * const sentrinel = initSentrinelBrowser({ release: "2026.8.2" });
 * sentrinel.setUser("user_123");
 * sentrinel.addBreadcrumb("checkout opened", { category: "ui" });
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SentrinelBrowserOptions {
  /**
   * Where batches are posted. Same-origin by default, which is what keeps the
   * ingest key on your server. Point it at the ingest API directly only if you
   * accept that the key in `headers` becomes public.
   */
  endpoint?: string;
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
  /** Messages matching any of these are dropped before they are recorded. */
  ignoreErrors?: (string | RegExp)[];
  /** Fraction of successful requests kept. Errors and slow calls are never sampled out. */
  sampleRate?: number;
  /** Above this, a request is kept regardless of `sampleRate`. */
  slowRequestThresholdMs?: number;
  /** Last chance to redact or drop a record. Return `null` to drop it. */
  beforeSend?: (record: BrowserRecord) => BrowserRecord | null;
  /** Log what the SDK is doing to the console. */
  debug?: boolean;
}

export type BrowserRecord =
  | ({ kind: "error" } & BrowserError)
  | ({ kind: "request" } & BrowserRequest);

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
  /** Who this is, so errors group by person on the Consumers page. */
  setUser(id: string | null | undefined): void;
  /** Key/values attached to everything sent from here on. */
  setContext(context: Record<string, unknown>): void;
  /** Send what is buffered now. */
  flush(): Promise<void>;
  /** Unpatch, end the session, send the last batch. */
  close(): Promise<void>;
  /** False when running on the server, where this is a no-op. */
  readonly enabled: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Browser noise that is never actionable.
 *
 * `Script error.` is what a cross-origin script failure looks like with no
 * `crossorigin` attribute — no message, no file, no line. `ResizeObserver loop`
 * is fired by the spec itself and is benign in almost every case. Reporting
 * these buries the errors that mean something.
 */
const DEFAULT_IGNORED: (string | RegExp)[] = [
  "Script error.",
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^Java(Script)? exception occurred/,
  // Browser extensions, not your app.
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
];

const BREADCRUMB_LIMIT = 25;
const MAX_STACK_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 2_000;

/** Errors have no HTTP method. `varchar(10)`, so this has to stay short. */
const BROWSER_METHOD = "BROWSER";

// ─── Init ───────────────────────────────────────────────────────────────────

let active: SentrinelBrowser | null = null;

const NOOP: SentrinelBrowser = {
  captureError() {},
  addBreadcrumb() {},
  setUser() {},
  setContext() {},
  async flush() {},
  async close() {},
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
export function initSentrinelBrowser(
  options: SentrinelBrowserOptions = {}
): SentrinelBrowser {
  if (typeof window === "undefined" || typeof document === "undefined") return NOOP;
  if (active) return active;
  active = new BrowserClient(options);
  return active;
}

/** The handle from `initSentrinelBrowser`, or a no-op if it was never called. */
export function getSentrinelBrowser(): SentrinelBrowser {
  return active ?? NOOP;
}

/** Test seam: forget the singleton so the next init builds a fresh client. */
export function resetSentrinelBrowser(): void {
  active = null;
}

// ─── Client ─────────────────────────────────────────────────────────────────

class BrowserClient implements SentrinelBrowser {
  readonly enabled = true;

  private readonly opts: Required<
    Pick<
      SentrinelBrowserOptions,
      | "endpoint"
      | "flushInterval"
      | "maxBatch"
      | "captureRequests"
      | "captureErrors"
      | "captureBreadcrumbs"
      | "trackSessions"
      | "sampleRate"
      | "slowRequestThresholdMs"
      | "debug"
    >
  > &
    SentrinelBrowserOptions;

  private errors: BrowserError[] = [];
  private requests: BrowserRequest[] = [];
  private breadcrumbs: Breadcrumb[] = [];
  private context: Record<string, unknown> = {};
  private userId: string | undefined;
  private ignored: (string | RegExp)[];
  private traceTargets: (string | RegExp)[];

  private session: BrowserSession | null = null;
  private sessionSent = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private originalFetch: typeof fetch | null = null;
  private teardown: Array<() => void> = [];
  private closed = false;
  private warned = new Set<string>();

  constructor(options: SentrinelBrowserOptions) {
    this.opts = {
      endpoint: "/api/_sentrinel",
      flushInterval: 10_000,
      maxBatch: 100,
      captureRequests: true,
      captureErrors: true,
      captureBreadcrumbs: true,
      trackSessions: true,
      sampleRate: 1,
      slowRequestThresholdMs: 2_000,
      debug: false,
      ...options,
    };

    this.ignored = [...DEFAULT_IGNORED, ...(options.ignoreErrors ?? [])];
    this.traceTargets = options.tracePropagationTargets ?? [sameOriginMatcher()];

    if (this.opts.trackSessions) this.startSession();
    if (this.opts.captureErrors) this.installErrorHandlers();
    if (this.opts.captureRequests) this.patchFetch();
    if (this.opts.captureBreadcrumbs) this.installBreadcrumbSources();
    this.installLifecycle();

    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
    // Never hold the page open on our account (Node/jsdom test envs only).
    (this.timer as any)?.unref?.();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  captureError(error: unknown, context?: Record<string, unknown>): void {
    this.record(error, { handled: true, context });
  }

  addBreadcrumb(message: string, options: Omit<Breadcrumb, "timestamp" | "message"> = {}): void {
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

  setUser(id: string | null | undefined): void {
    this.userId = id ?? undefined;
    if (this.session) this.session.userId = this.userId;
  }

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  async flush(): Promise<void> {
    const payload = this.drain();
    if (!payload) return;
    await this.send(payload, false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.endSession("ok");
    for (const undo of this.teardown.splice(0)) {
      try {
        undo();
      } catch {
        // An unpatch that throws must not stop the rest from being undone.
      }
    }
    await this.flush();
    if (active === (this as unknown as SentrinelBrowser)) active = null;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  private startSession(): void {
    this.session = {
      sessionId: randomId(32),
      status: "ok",
      release: this.opts.release,
      startedAt: new Date().toISOString(),
      userId: this.userId,
      attributes: { platform: "browser", ...deviceContext() },
    };
  }

  /**
   * Raise the session's status, never lower it.
   *
   * A page that crashes and then reports a handled error is still a crash; the
   * ordering of the two events should not change the release's number.
   */
  private markSession(status: BrowserSession["status"]): void {
    if (!this.session) return;
    const RANK = { ok: 0, errored: 1, abnormal: 2, crashed: 3 } as const;
    if (RANK[status] > RANK[this.session.status]) {
      this.session.status = status;
      this.sessionSent = false; // status changed — worth resending
    }
  }

  private endSession(status: BrowserSession["status"]): void {
    if (!this.session) return;
    this.markSession(status);
    this.session.endedAt = new Date().toISOString();
    this.sessionSent = false;
  }

  // ── Error capture ─────────────────────────────────────────────────────────

  private installErrorHandlers(): void {
    const onError = (event: ErrorEvent) => {
      this.record(event.error ?? event.message, {
        handled: false,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
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

  private record(
    error: unknown,
    meta: {
      handled: boolean;
      source?: string;
      line?: number;
      column?: number;
      mechanism?: string;
      context?: Record<string, unknown>;
    }
  ): void {
    const { type, message, stack } = describe(error);
    if (this.isIgnored(message) || (meta.source && this.isIgnored(meta.source))) {
      this.log("ignored:", message);
      return;
    }

    this.markSession(meta.handled ? "errored" : "crashed");

    const record: BrowserError = {
      method: BROWSER_METHOD,
      path: currentPath(),
      // No HTTP exchange happened, so there is no status. 0 says "not a
      // response" instead of inventing a 500 that nobody sent.
      statusCode: 0,
      statusMessage: meta.handled ? "Handled error" : "Unhandled error",
      errorType: type,
      errorMessage: truncate(message, MAX_MESSAGE_CHARS),
      stackTrace: stack ? truncate(stack, MAX_STACK_CHARS) : undefined,
      consumerIdentifier: this.userId ?? null,
      timestamp: new Date().toISOString(),
      attributes: {
        ...this.context,
        ...meta.context,
        "error.handled": meta.handled,
        "error.mechanism": meta.mechanism ?? (meta.handled ? "captureError" : "onerror"),
        "browser.url": currentUrl(),
        ...(meta.source ? { "error.source": meta.source } : {}),
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
    if (!kept) return;
    const { kind: _kind, ...rest } = kept as { kind: "error" } & BrowserError;
    this.errors.push(rest);
    this.addBreadcrumb(message, { category: "error", level: "error" });
    this.maybeFlush();
  }

  private isIgnored(text: string): boolean {
    return this.ignored.some((p) =>
      typeof p === "string" ? text.includes(p) : p.test(text)
    );
  }

  // ── Request capture ───────────────────────────────────────────────────────

  private patchFetch(): void {
    if (typeof window.fetch !== "function") return;
    const original = window.fetch.bind(window);
    this.originalFetch = original;

    const wrapper = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      // Our own batches must not be recorded, or every flush produces a record
      // that triggers the next flush.
      if (this.isOwnEndpoint(url)) return original(input, init);

      const method = (
        init?.method ??
        (typeof input === "object" && input && "method" in input ? (input as Request).method : "GET")
      ).toUpperCase();

      const started = now();
      const traceId = randomId(32);
      let headers = init?.headers;

      if (this.shouldPropagate(url)) {
        // 01 = sampled. The backend continues this trace rather than starting
        // its own, which is what puts the click and the handler on one waterfall.
        const merged = new Headers(headers ?? (input instanceof Request ? input.headers : undefined));
        if (!merged.has("traceparent")) {
          merged.set("traceparent", `00-${traceId}-${randomId(16)}-01`);
        }
        headers = merged;
        init = { ...init, headers };
      }

      try {
        const response = await original(input, init as RequestInit);
        this.recordRequest({ url, method, status: response.status, started, traceId });
        return response;
      } catch (err) {
        // A network failure never reached a server, so there is no status.
        this.recordRequest({
          url,
          method,
          status: 0,
          started,
          traceId,
          error: (err as Error)?.message ?? String(err),
        });
        throw err;
      }
    };

    // Carry over anything the environment hung on `fetch` — Bun adds
    // `fetch.preconnect`. Replacing the function without them would quietly
    // remove API that callers may be using.
    const patched = Object.assign(wrapper, window.fetch) as unknown as typeof fetch;

    window.fetch = patched;
    this.teardown.push(() => {
      // Only restore if nobody patched over us in the meantime — clobbering a
      // later SDK's wrapper would silently disable it.
      if (window.fetch === patched && this.originalFetch) window.fetch = this.originalFetch;
    });
  }

  private isOwnEndpoint(url: string): boolean {
    try {
      return new URL(url, location.href).pathname === new URL(this.opts.endpoint, location.href).pathname;
    } catch {
      return url.includes(this.opts.endpoint);
    }
  }

  private shouldPropagate(url: string): boolean {
    return this.traceTargets.some((t) => (typeof t === "string" ? url.includes(t) : t.test(url)));
  }

  private recordRequest(args: {
    url: string;
    method: string;
    status: number;
    started: number;
    traceId: string;
    error?: string;
  }): void {
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
    if (!keep) return;

    const id = randomId(32);
    const record: BrowserRequest = {
      id,
      method: args.method,
      path: pathOf(args.url),
      statusCode: args.status,
      responseTime: Math.round(ms * 100) / 100,
      requestSize: 0,
      responseSize: 0,
      consumerIdentifier: this.userId ?? null,
      queryParams: queryOf(args.url),
      errorMessage: args.error,
      traceId: args.traceId,
      timestamp: new Date(Date.now() - ms).toISOString(),
      sampleRate: failed || slow ? 1 : this.opts.sampleRate,
      attributes: {
        ...this.context,
        "browser.url": currentUrl(),
        "http.url": args.url,
        ...(this.session ? { "session.id": this.session.sessionId } : {}),
        ...(this.opts.release ? { release: this.opts.release } : {}),
      },
    };

    const kept = this.applyBeforeSend({ kind: "request", ...record });
    if (!kept) return;
    const { kind: _kind, ...rest } = kept as { kind: "request" } & BrowserRequest;
    this.requests.push(rest);

    if (args.error) {
      this.errors.push({
        method: args.method,
        path: pathOf(args.url),
        statusCode: args.status,
        statusMessage: args.error,
        errorType: "NetworkError",
        errorMessage: truncate(args.error, MAX_MESSAGE_CHARS),
        consumerIdentifier: this.userId ?? null,
        timestamp: new Date().toISOString(),
        traceId: args.traceId,
        // What lets an issue open the exact request that produced it.
        requestLogId: id,
        attributes: { ...this.context, "browser.url": currentUrl() },
      });
      this.markSession("errored");
    }

    this.maybeFlush();
  }

  // ── Breadcrumbs ───────────────────────────────────────────────────────────

  private installBreadcrumbSources(): void {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.tagName) return;
      this.addBreadcrumb(describeElement(target), { category: "ui.click" });
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    this.teardown.push(() => document.removeEventListener("click", onClick, { capture: true }));

    // History is patched rather than listened to because pushState fires no
    // event — an SPA route change would otherwise leave no trace at all.
    let last = currentPath();
    const note = () => {
      const next = currentPath();
      if (next === last) return;
      this.addBreadcrumb(`${last} → ${next}`, { category: "navigation" });
      last = next;
    };

    const history = window.history;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      const out = originalPush.apply(this, args);
      note();
      return out;
    };
    history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
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

  private installLifecycle(): void {
    // pagehide, not unload: unload is unreliable on mobile Safari and blocks
    // the back/forward cache. This is the last moment guaranteed to run.
    const onHide = () => {
      if (document.visibilityState === "hidden" || !this.session?.endedAt) {
        this.endSession("ok");
      }
      const payload = this.drain();
      if (payload) void this.send(payload, true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onHide();
    });
    this.teardown.push(() => window.removeEventListener("pagehide", onHide));
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private maybeFlush(): void {
    if (this.errors.length + this.requests.length >= this.opts.maxBatch) void this.flush();
  }

  private drain(): BatchPayload | null {
    const sendSession = this.session && !this.sessionSent;
    if (!this.errors.length && !this.requests.length && !sendSession) return null;

    const payload: BatchPayload = {
      release: this.opts.release,
      errors: this.errors.splice(0),
      requests: this.requests.splice(0),
      sessions: sendSession ? [{ ...this.session! }] : [],
    };
    if (sendSession) this.sessionSent = true;
    return payload;
  }

  private async send(payload: BatchPayload, beacon: boolean): Promise<void> {
    const body = JSON.stringify(payload);
    const url = this.opts.endpoint;

    // sendBeacon is the only transport a browser guarantees to complete once
    // the page is going away. It has no headers, so it is used only when a
    // tunnel makes them unnecessary.
    if (beacon && !this.opts.headers && typeof navigator !== "undefined" && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
      } catch {
        // Fall through to fetch — a rejected beacon is better retried than lost.
      }
    }

    const send = this.originalFetch ?? fetch;
    try {
      const res = await send(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.opts.headers ?? {}) },
        body,
        // Survives the page navigating away mid-request.
        keepalive: body.length < 60_000,
        credentials: "same-origin",
      });
      if (!res.ok) {
        this.warnOnce(
          String(res.status),
          `telemetry rejected (${res.status}). Check that ${url} is reachable and that ` +
            `the tunnel's apiKey, appName and env match.`
        );
        return;
      }
      this.warned.clear();
      this.log("sent", payload.errors.length, "errors,", payload.requests.length, "requests");
    } catch (err) {
      this.warnOnce("connect", `cannot reach ${url} — ${(err as Error)?.message ?? err}`);
    }
  }

  private applyBeforeSend(record: BrowserRecord): BrowserRecord | null {
    if (!this.opts.beforeSend) return record;
    try {
      return this.opts.beforeSend(record);
    } catch (err) {
      // A throwing hook must not swallow the error it was inspecting.
      this.warnOnce("beforeSend", `beforeSend threw: ${(err as Error)?.message ?? err}`);
      return record;
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[sentrinel] ${message}`);
  }

  private log(...args: unknown[]): void {
    if (this.opts.debug) console.log("[sentrinel]", ...args);
  }
}

export interface BatchPayload {
  release?: string;
  errors: BrowserError[];
  requests: BrowserRequest[];
  sessions: BrowserSession[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sameOriginMatcher(): RegExp {
  if (typeof location === "undefined") return /^\//;
  // Relative URLs, or absolute ones on this origin.
  return new RegExp(`^(/(?!/)|${escapeRegExp(location.origin)})`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describe(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message || String(error), stack: error.stack };
  }
  if (typeof error === "string") return { type: "Error", message: error };
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const message =
      typeof obj.message === "string" ? obj.message : safeStringify(obj);
    return {
      type: typeof obj.name === "string" ? obj.name : "Error",
      message,
      stack: typeof obj.stack === "string" ? obj.stack : undefined,
    };
  }
  return { type: "Error", message: String(error) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  const text = (el.textContent ?? "").trim().slice(0, 40);
  return `${tag}${id}${cls}${text ? ` "${text}"` : ""}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
    return parsed.pathname || "/";
  } catch {
    return url.split("?")[0] || "/";
  }
}

function queryOf(url: string): Record<string, string> | undefined {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
    const out: Record<string, string> = {};
    parsed.searchParams.forEach((v, k) => (out[k] = v));
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function currentPath(): string {
  return typeof location === "undefined" ? "/" : location.pathname || "/";
}

function currentUrl(): string {
  return typeof location === "undefined" ? "" : location.href;
}

function deviceContext(): Record<string, unknown> {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string } };
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

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const HEX = "0123456789abcdef";

function randomId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}
