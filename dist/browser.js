var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/replay.ts
var DEFAULTS = {
  bufferSeconds: 30,
  tailSeconds: 5,
  maxBufferBytes: 2 * 1024 * 1024,
  sessionSampleRate: 0,
  unmaskSelector: "[data-sentrinel-unmask]",
  blockSelector: "[data-sentrinel-block]"
};
var FULL_SNAPSHOT = 2;
var META = 4;
function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  (globalThis.crypto ?? {}).getRandomValues?.(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function startReplay(options, send, getSessionId, getConsumer) {
  if (options.enabled === false)
    return null;
  if (typeof window === "undefined" || typeof document === "undefined")
    return null;
  const opts = { ...DEFAULTS, ...options };
  const replayId = randomId(16);
  let record = opts.recorder?.record;
  if (!record) {
    try {
      const mod = await import("rrweb");
      record = mod.record ?? mod.default?.record;
    } catch {
      if (opts.debug) {
        console.warn("[sentrinel] session replay is enabled but rrweb could not be loaded. Install it (`npm i rrweb`) or pass `recorder` explicitly.");
      }
      return null;
    }
  }
  if (typeof record !== "function")
    return null;
  let buffer = [];
  let lastMeta = null;
  let bufferBytes = 0;
  let seq = 0;
  let stopped = false;
  let tailTimer = null;
  let pendingErrorId;
  const sampled = opts.sessionSampleRate > 0 && Math.random() < opts.sessionSampleRate;
  const trim = () => {
    const cutoff = Date.now() - opts.bufferSeconds * 1000;
    let keepFrom = 0;
    for (let i = buffer.length - 1;i >= 0; i--) {
      if (buffer[i].type === FULL_SNAPSHOT) {
        keepFrom = i;
        break;
      }
    }
    let cut = 0;
    while (cut < keepFrom && buffer[cut].timestamp < cutoff)
      cut++;
    if (cut > 0)
      buffer = buffer.slice(cut);
    while (bufferBytes > opts.maxBufferBytes && buffer.length > 1) {
      let snapshotAt = -1;
      for (let i = 1;i < buffer.length; i++) {
        if (buffer[i].type === FULL_SNAPSHOT) {
          snapshotAt = i;
          break;
        }
      }
      if (snapshotAt <= 0)
        break;
      buffer = buffer.slice(snapshotAt);
      bufferBytes = approxBytes(buffer);
    }
  };
  const emit = (trigger, errorId) => {
    if (!buffer.length)
      return;
    const events = lastMeta ? [lastMeta, ...buffer] : buffer;
    buffer = [];
    bufferBytes = 0;
    const startedAt = events[0]?.timestamp ?? Date.now();
    const endedAt = events[events.length - 1]?.timestamp ?? startedAt;
    send({
      replayId,
      sessionId: getSessionId?.(),
      consumerIdentifier: getConsumer?.(),
      seq: seq++,
      events,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, endedAt - startedAt),
      url: typeof location !== "undefined" ? location.href : undefined,
      trigger,
      errorId
    });
  };
  const stopFn = record({
    emit(event) {
      if (stopped)
        return;
      if (event.type === META) {
        lastMeta = event;
        return;
      }
      buffer.push(event);
      bufferBytes += approxOne(event);
      trim();
      if (sampled && bufferBytes > 65536)
        emit("sampled");
    },
    maskAllInputs: true,
    maskTextSelector: "*",
    unmaskTextSelector: opts.unmaskSelector,
    blockSelector: opts.blockSelector,
    recordCanvas: false,
    collectFonts: false,
    checkoutEveryNms: Math.max(1e4, opts.bufferSeconds * 1000 / 2)
  });
  if (opts.debug) {
    console.log(`[sentrinel] replay recording (${sampled ? "sampled session" : "errors only"}), id ${replayId}`);
  }
  const controller = {
    replayId,
    get recording() {
      return !stopped;
    },
    onError(errorId) {
      if (stopped)
        return;
      pendingErrorId = pendingErrorId ?? errorId;
      if (tailTimer)
        return;
      tailTimer = setTimeout(() => {
        tailTimer = null;
        emit("error", pendingErrorId);
        pendingErrorId = undefined;
      }, opts.tailSeconds * 1000);
    },
    flush() {
      if (tailTimer) {
        clearTimeout(tailTimer);
        tailTimer = null;
        emit("error", pendingErrorId);
        pendingErrorId = undefined;
      } else if (sampled) {
        emit("sampled");
      }
    },
    stop() {
      stopped = true;
      if (tailTimer)
        clearTimeout(tailTimer);
      tailTimer = null;
      buffer = [];
      bufferBytes = 0;
      try {
        stopFn?.();
      } catch {}
    }
  };
  return controller;
}
function approxOne(event) {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 512;
  }
}
function approxBytes(events) {
  let n = 0;
  for (const e of events)
    n += approxOne(e);
  return n;
}

// src/masking.ts
var MASK_VALUE = "***";
function normalise(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
var SECRET_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "creditcard",
  "cardnumber",
  "ccnumber",
  "cvv",
  "cvc",
  "privatekey",
  "credential"
];
var SECRET_SUFFIXES = ["token", "signature"];
var SECRET_EXACT_BODY = new Set(["pwd", "pin", "ssn", "otp"]);
function isDefaultSecretName(name) {
  const n = normalise(name);
  if (!n)
    return false;
  if (SECRET_EXACT_BODY.has(n))
    return true;
  if (SECRET_SUFFIXES.some((s) => n.endsWith(s)))
    return true;
  return SECRET_FRAGMENTS.some((f) => n.includes(f));
}
var SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token"
]);
var SECRET_QUERY_EXACT = new Set([
  "token",
  "key",
  "apikey",
  "code",
  "password",
  "signature",
  "sig",
  "secret",
  "auth",
  "session",
  "sessionid",
  "jwt"
]);
function isDefaultSecretQueryKey(name) {
  const n = normalise(name);
  return SECRET_QUERY_EXACT.has(n) || isDefaultSecretName(name);
}
function matchesPattern(fieldName, patterns) {
  if (!patterns)
    return false;
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (fieldName.toLowerCase() === pattern.toLowerCase())
        return true;
    } else if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      if (pattern.test(fieldName))
        return true;
    }
  }
  return false;
}
function shouldMaskQueryKey(name, patterns) {
  return isDefaultSecretQueryKey(name) || matchesPattern(name, patterns);
}
function maskQueryParams(params, patterns) {
  if (!params)
    return;
  const masked = {};
  for (const [key, value] of Object.entries(params)) {
    masked[key] = shouldMaskQueryKey(key, patterns) ? MASK_VALUE : value;
  }
  return masked;
}
function maskUrl(url, patterns) {
  if (!url || url.indexOf("?") < 0 && url.indexOf("#") < 0)
    return url;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt + 1) : undefined;
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : undefined;
  let out = base;
  if (query !== undefined)
    out += `?${maskParamString(query, patterns)}`;
  if (hash !== undefined) {
    out += `#${hash.includes("=") ? maskParamString(hash, patterns) : hash}`;
  }
  return out;
}
function maskParamString(params, patterns) {
  return params.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0)
      return pair;
    const rawKey = pair.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {}
    return shouldMaskQueryKey(key, patterns) ? `${rawKey}=${MASK_VALUE}` : pair;
  }).join("&");
}

// src/browser.ts
var DEFAULT_IGNORED = [
  "Script error.",
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^Java(Script)? exception occurred/,
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//
];
var BREADCRUMB_LIMIT = 25;
var MAX_STACK_CHARS = 8000;
var MAX_MESSAGE_CHARS = 2000;
var BROWSER_METHOD = "BROWSER";
var DEFAULT_ENDPOINT = "/api/sentrinel";
var MAX_OUTBOX = 50;
var MAX_OUTBOX_BYTES = 1024 * 1024;
var MAX_SEND_ATTEMPTS = 8;
var UNLOAD_BODY_LIMIT = 60000;
var active = null;
var NOOP = {
  captureError() {},
  addBreadcrumb() {},
  setUser() {},
  identify() {},
  reset() {},
  consumer: "",
  deviceId: "",
  setContext() {},
  track() {},
  page() {},
  async flush() {},
  async close() {},
  enabled: false
};
function initSentrinelBrowser(options = {}) {
  if (typeof window === "undefined" || typeof document === "undefined")
    return NOOP;
  if (active)
    return active;
  active = new BrowserClient(options);
  return active;
}
function getSentrinelBrowser() {
  return active ?? NOOP;
}
function resetSentrinelBrowser() {
  active = null;
}

class BrowserClient {
  enabled = true;
  opts;
  errors = [];
  requests = [];
  breadcrumbs = [];
  context = {};
  userId;
  ignored;
  traceTargets;
  session = null;
  sessionSent = false;
  vitals = {};
  noteVitalChange() {
    if (!this.session)
      return;
    if (this.sessionSent) {
      this.sessionSent = false;
      this.maybeFlush();
    }
  }
  events = [];
  anonymousId = "";
  lastPath = "";
  lastPageAt = 0;
  currentTraceId;
  timer = null;
  originalFetch = null;
  teardown = [];
  replay = null;
  closed = false;
  warned = new Set;
  outbox = [];
  pumping = null;
  droppedBatches = 0;
  constructor(options) {
    this.opts = {
      endpoint: DEFAULT_ENDPOINT,
      flushInterval: 1e4,
      maxBatch: 100,
      captureRequests: true,
      captureErrors: true,
      captureBreadcrumbs: true,
      trackSessions: true,
      sampleRate: 1,
      slowRequestThresholdMs: 2000,
      debug: false,
      ...options
    };
    this.ignored = [...DEFAULT_IGNORED, ...options.ignoreErrors ?? []];
    this.traceTargets = options.tracePropagationTargets ?? [sameOriginMatcher()];
    this.anonymousId = loadAnonymousId();
    if (this.opts.trackSessions)
      this.startSession();
    if (this.opts.autoPageviews !== false)
      this.installPageviewTracking();
    if (this.opts.captureWebVitals !== false)
      this.installVitalsCollection();
    if (this.opts.replay?.enabled)
      this.startReplayRecorder();
    if (this.opts.captureErrors)
      this.installErrorHandlers();
    if (this.opts.captureRequests)
      this.patchFetch();
    if (this.opts.captureBreadcrumbs)
      this.installBreadcrumbSources();
    this.installLifecycle();
    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
    this.timer?.unref?.();
  }
  captureError(error, context) {
    this.record(error, { handled: true, context });
  }
  addBreadcrumb(message, options = {}) {
    this.breadcrumbs.push({
      timestamp: new Date().toISOString(),
      message: truncate(message, 500),
      ...options
    });
    if (this.breadcrumbs.length > BREADCRUMB_LIMIT) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - BREADCRUMB_LIMIT);
    }
  }
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
    if (this.userId && this.userId !== previous) {
      this.events.push({
        kind: "identify",
        name: "identify",
        timestamp: new Date().toISOString(),
        anonymousId: this.anonymousId,
        userId: this.userId,
        sessionId: this.session?.sessionId
      });
      this.maybeFlush();
    }
  }
  track(name, properties) {
    if (!name || typeof name !== "string")
      return;
    this.events.push({
      kind: "track",
      name: name.slice(0, 200),
      timestamp: new Date().toISOString(),
      anonymousId: this.anonymousId,
      userId: this.userId,
      sessionId: this.session?.sessionId,
      properties,
      traceId: this.currentTraceId
    });
    if (this.session)
      this.session.events = (this.session.events ?? 0) + 1;
    this.maybeFlush();
  }
  page(name, properties) {
    const path = name ?? (typeof location !== "undefined" ? this.mask(location.pathname + location.search) : "");
    if (!path)
      return;
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
      durationMs: duration > 0 && duration < 3600000 ? duration : 0
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
    for (const undo of this.teardown.splice(0).reverse()) {
      try {
        undo();
      } catch {}
    }
    await this.flush();
    if (active === this)
      active = null;
  }
  startSession() {
    this.session = {
      sessionId: randomId2(32),
      status: "ok",
      release: this.opts.release,
      startedAt: new Date().toISOString(),
      userId: this.userId,
      attributes: { platform: "browser", "device.id": this.anonymousId, ...deviceContext() }
    };
  }
  mask(url) {
    return maskUrl(url, this.opts.maskQueryParams);
  }
  markSession(status) {
    if (!this.session)
      return;
    const RANK = { ok: 0, errored: 1, abnormal: 2, crashed: 3 };
    if (RANK[status] > RANK[this.session.status]) {
      this.session.status = status;
      this.sessionSent = false;
    }
  }
  endSession(status) {
    if (!this.session)
      return;
    this.markSession(status);
    this.session.endedAt = new Date().toISOString();
    this.sessionSent = false;
  }
  installVitalsCollection() {
    if (typeof PerformanceObserver === "undefined")
      return;
    try {
      this.vitalsCollection();
    } catch {}
  }
  vitalsCollection() {
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
    const inpType = PerformanceObserver.supportedEntryTypes?.includes("event") ? "event" : PerformanceObserver.supportedEntryTypes?.includes("first-input") ? "first-input" : null;
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
        obs.observe({ type: inpType, buffered: true, durationThreshold: 40 });
      } catch {
        obs.observe({ type: inpType, buffered: true });
      }
      this.teardown.push(() => obs.disconnect());
    }
  }
  installErrorHandlers() {
    const onError = (event) => {
      this.record(event.error ?? event.message, {
        handled: false,
        source: event.filename,
        line: event.lineno,
        column: event.colno
      });
    };
    const onRejection = (event) => {
      this.record(event.reason, { handled: false, mechanism: "unhandledrejection" });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    this.teardown.push(() => window.removeEventListener("error", onError));
    this.teardown.push(() => window.removeEventListener("unhandledrejection", onRejection));
  }
  record(error, meta) {
    const { type, message, stack } = describe(error);
    if (this.isIgnored(message) || meta.source && this.isIgnored(meta.source)) {
      this.log("ignored:", message);
      return;
    }
    this.markSession(meta.handled ? "errored" : "crashed");
    const record = {
      method: BROWSER_METHOD,
      path: currentPath(),
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
        ...meta.source ? { "error.source": this.mask(meta.source) } : {},
        ...meta.line != null ? { "error.line": meta.line } : {},
        ...meta.column != null ? { "error.column": meta.column } : {},
        ...this.session ? { "session.id": this.session.sessionId } : {},
        ...this.opts.release ? { release: this.opts.release } : {},
        ...deviceContext(),
        ...this.breadcrumbs.length ? { breadcrumbs: [...this.breadcrumbs] } : {}
      }
    };
    const kept = this.applyBeforeSend({ kind: "error", ...record });
    if (!kept)
      return;
    const { kind: _kind, ...rest } = kept;
    this.errors.push(rest);
    this.replay?.onError(`${rest.errorType ?? "Error"}: ${rest.errorMessage ?? ""}`.trim());
    this.addBreadcrumb(message, { category: "error", level: "error" });
    this.maybeFlush();
  }
  isIgnored(text) {
    return this.ignored.some((p) => typeof p === "string" ? text.includes(p) : p.test(text));
  }
  patchFetch() {
    if (typeof window.fetch !== "function")
      return;
    const original = window.fetch.bind(window);
    this.originalFetch = original;
    const wrapper = async (input, init) => {
      const url = requestUrl(input);
      if (this.isOwnEndpoint(url))
        return original(input, init);
      const method = (init?.method ?? (typeof input === "object" && input && "method" in input ? input.method : "GET")).toUpperCase();
      const started = now();
      const traceId = randomId2(32);
      const spanId = randomId2(16);
      let propagated = false;
      let headers = init?.headers;
      if (this.shouldPropagate(url)) {
        const merged = new Headers(headers ?? (input instanceof Request ? input.headers : undefined));
        if (!merged.has("traceparent")) {
          merged.set("traceparent", `00-${traceId}-${spanId}-01`);
          propagated = true;
        }
        setHeaderSafely(merged, "x-sentrinel-consumer", this.consumer);
        setHeaderSafely(merged, "x-sentrinel-device", this.anonymousId);
        headers = merged;
        init = { ...init, headers };
      }
      try {
        const response = await original(input, init);
        this.recordRequest({ url, method, status: response.status, started, traceId, spanId: propagated ? spanId : undefined });
        return response;
      } catch (err) {
        this.recordRequest({
          url,
          method,
          status: 0,
          started,
          traceId,
          spanId: propagated ? spanId : undefined,
          error: err?.message ?? String(err)
        });
        throw err;
      }
    };
    const patched = Object.assign(wrapper, window.fetch);
    window.fetch = patched;
    this.teardown.push(() => {
      if (window.fetch === patched && this.originalFetch)
        window.fetch = this.originalFetch;
    });
  }
  isOwnEndpoint(url) {
    try {
      return new URL(url, location.href).pathname === new URL(this.opts.endpoint, location.href).pathname;
    } catch {
      return url.includes(this.opts.endpoint);
    }
  }
  isFirstParty(url) {
    try {
      if (new URL(url, location.href).origin === location.origin)
        return true;
    } catch {}
    return this.shouldPropagate(url);
  }
  shouldPropagate(url) {
    return this.traceTargets.some((t) => typeof t === "string" ? url.includes(t) : t.test(url));
  }
  recordRequest(args) {
    const ms = now() - args.started;
    const failed = args.status === 0 || args.status >= 400;
    const slow = ms >= this.opts.slowRequestThresholdMs;
    this.addBreadcrumb(`${args.method} ${pathOf(args.url)}`, {
      category: "http",
      level: failed ? "error" : "info",
      data: { status: args.status, ms: Math.round(ms) }
    });
    const keep = failed || slow || Math.random() < this.opts.sampleRate;
    if (!keep)
      return;
    const id = randomId2(32);
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
      queryParams: query ? maskQueryParams(query, this.opts.maskQueryParams) : undefined,
      errorMessage: args.error,
      traceId: args.traceId,
      spanId: args.spanId,
      timestamp: new Date(Date.now() - ms).toISOString(),
      sampleRate: failed || slow ? 1 : this.opts.sampleRate,
      attributes: {
        ...this.context,
        "sentrinel.kind": "client",
        "http.host": hostOf(args.url),
        ...firstParty ? {} : { "sentrinel.third_party": true },
        "browser.url": this.mask(currentUrl()),
        "http.url": this.mask(args.url),
        "device.id": this.anonymousId,
        ...this.session ? { "session.id": this.session.sessionId } : {},
        ...this.opts.release ? { release: this.opts.release } : {}
      }
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
        requestLogId: id,
        attributes: {
          ...this.context,
          "browser.url": this.mask(currentUrl()),
          "http.url": this.mask(args.url),
          "device.id": this.anonymousId
        }
      });
      this.markSession("errored");
    }
    this.maybeFlush();
  }
  installBreadcrumbSources() {
    const onClick = (event) => {
      const target = event.target;
      if (!target?.tagName)
        return;
      this.addBreadcrumb(describeElement(target), { category: "ui.click" });
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    this.teardown.push(() => document.removeEventListener("click", onClick, { capture: true }));
    let last = currentPath();
    const note = () => {
      const next = currentPath();
      if (next === last)
        return;
      this.addBreadcrumb(`${last} → ${next}`, { category: "navigation" });
      last = next;
    };
    const history2 = window.history;
    const originalPush = history2.pushState;
    const originalReplace = history2.replaceState;
    history2.pushState = function(...args) {
      const out = originalPush.apply(this, args);
      note();
      return out;
    };
    history2.replaceState = function(...args) {
      const out = originalReplace.apply(this, args);
      note();
      return out;
    };
    window.addEventListener("popstate", note);
    this.teardown.push(() => {
      history2.pushState = originalPush;
      history2.replaceState = originalReplace;
      window.removeEventListener("popstate", note);
    });
  }
  installLifecycle() {
    const onHide = () => {
      if (document.visibilityState === "hidden" || !this.session?.endedAt) {
        this.endSession("ok");
      }
      this.flushForUnload();
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
  installPageviewTracking() {
    if (typeof window === "undefined" || typeof history === "undefined")
      return;
    this.page();
    const emit = () => {
      const path = this.mask(location.pathname + location.search);
      if (path === this.lastPath)
        return;
      this.page();
    };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function(...args) {
      const result = originalPush.apply(this, args);
      queueMicrotask(emit);
      return result;
    };
    history.replaceState = function(...args) {
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
      this.flush();
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
      sessions: sendSession ? [{ ...this.session, vitals: { ...this.vitals } }] : []
    };
    if (sendSession)
      this.sessionSent = true;
    return payload;
  }
  enqueue(payload) {
    for (const part of splitBatch(payload)) {
      const bytes = safeStringify(part).length;
      this.outbox.push({ payload: part, bytes, attempts: 0, nextAt: 0, inflight: false });
    }
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
      this.warnOnce("outbox", `telemetry could not be delivered to ${this.opts.endpoint} and the backlog is full — ` + `dropping the oldest batches.`);
    }
  }
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
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }
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
    if (pending.payload.sessions?.length) {
      pending.payload = { ...pending.payload, sessions: [] };
      if (this.session)
        this.sessionSent = false;
    }
    pending.attempts++;
    const empty = !pending.payload.errors.length && !pending.payload.requests.length && !(pending.payload.events?.length ?? 0);
    if (empty) {
      remove();
    } else if (pending.attempts >= MAX_SEND_ATTEMPTS) {
      remove();
      this.droppedBatches++;
    } else {
      const backoff = Math.min(60000, 2000 * 2 ** (pending.attempts - 1));
      pending.nextAt = Date.now() + backoff * (0.5 + Math.random() * 0.5);
    }
    return false;
  }
  flushForUnload() {
    const payload = this.drain();
    if (payload)
      this.enqueue(payload);
    for (const pending of [...this.outbox]) {
      if (pending.inflight)
        continue;
      if (this.canBeacon() && pending.bytes <= UNLOAD_BODY_LIMIT) {
        try {
          const body = safeStringify(pending.payload);
          if (navigator.sendBeacon(this.opts.endpoint, new Blob([body], { type: "application/json" }))) {
            this.settle(pending, "ok");
            continue;
          }
        } catch {}
      }
      pending.inflight = true;
      this.post(pending.payload, pending.bytes, true).then((result) => {
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
        headers: { "Content-Type": "application/json", ...this.opts.headers ?? {} },
        body: safeStringify(payload),
        keepalive: bytes <= UNLOAD_BODY_LIMIT,
        credentials: "same-origin"
      });
      if (res.ok) {
        this.warned.delete("connect");
        this.warned.delete(String(res.status));
        this.log("sent", payload.errors.length, "errors,", payload.requests.length, "requests");
        return "ok";
      }
      this.warnOnce(String(res.status), `telemetry rejected (${res.status}). Check that ${url} is reachable and that ` + `the tunnel's apiKey and env match.`);
      return res.status === 408 || res.status === 429 || res.status >= 500 ? "retry" : "drop";
    } catch (err) {
      if (!unloading)
        this.warnOnce("connect", `cannot reach ${url} — ${err?.message ?? err}`);
      return "retry";
    }
  }
  async startReplayRecorder() {
    try {
      this.replay = await startReplay({ debug: this.opts.debug, ...this.opts.replay }, (upload) => void this.sendReplay(upload), () => this.session?.sessionId, () => this.consumer);
      if (this.replay)
        this.teardown.push(() => this.replay?.stop());
    } catch (err) {
      this.warnOnce("replay", `session replay failed to start: ${err?.message ?? err}`);
    }
  }
  async sendReplay(upload) {
    const send = this.originalFetch ?? fetch;
    const masked = {
      ...upload,
      url: upload.url ? this.mask(upload.url) : upload.url,
      events: upload.events.map((e) => {
        const data = e.data;
        return typeof data?.href === "string" ? { ...e, data: { ...data, href: this.mask(data.href) } } : e;
      })
    };
    const body = JSON.stringify({ replay: masked, release: this.opts.release });
    try {
      const res = await send(this.opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.opts.headers ?? {} },
        body,
        credentials: "same-origin"
      });
      if (!res.ok) {
        this.warnOnce("replay-send", `replay rejected (${res.status}) by ${this.opts.endpoint}`);
        return;
      }
      this.log("replay chunk sent:", upload.events.length, "events");
    } catch (err) {
      this.warnOnce("replay-send", `replay upload failed — ${err?.message ?? err}`);
    }
  }
  applyBeforeSend(record) {
    if (!this.opts.beforeSend)
      return record;
    try {
      return this.opts.beforeSend(record);
    } catch (err) {
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
function sameOriginMatcher() {
  if (typeof location === "undefined")
    return /^\//;
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
      stack: typeof obj.stack === "string" ? obj.stack : undefined
    };
  }
  return { type: "Error", message: String(error) };
}
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function setHeaderSafely(headers, name, value) {
  if (!value || headers.has(name))
    return;
  if (value.length > 255 || !/^[\x20-\x7e]+$/.test(value))
    return;
  try {
    headers.set(name, value);
  } catch {}
}
function hostOf(url) {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : "http://localhost").host;
  } catch {
    return "";
  }
}
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
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
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
  } catch {
    return url.split("?")[0] || "/";
  }
}
function queryOf(url) {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
    const out = {};
    parsed.searchParams.forEach((v, k) => out[k] = v);
    return Object.keys(out).length ? out : undefined;
  } catch {
    return;
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
    ...nav.hardwareConcurrency ? { "device.cores": nav.hardwareConcurrency } : {},
    ...nav.deviceMemory ? { "device.memory_gb": nav.deviceMemory } : {},
    ...nav.connection?.effectiveType ? { "network.type": nav.connection.effectiveType } : {},
    ...typeof screen !== "undefined" ? { "screen.size": `${screen.width}x${screen.height}` } : {}
  };
}
function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
var HEX = "0123456789abcdef";
function randomId2(length) {
  const bytes = new Uint8Array(length / 2);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0;i < bytes.length; i++)
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
var ANON_KEY = "sentrinel_anonymous_id";
function loadAnonymousId() {
  const fresh = `anon_${randomId2(24)}`;
  try {
    if (typeof localStorage === "undefined")
      return fresh;
    const existing = localStorage.getItem(ANON_KEY);
    if (existing && /^anon_[A-Za-z0-9_-]{8,}$/.test(existing))
      return existing;
    localStorage.setItem(ANON_KEY, fresh);
    return fresh;
  } catch {
    return fresh;
  }
}
export {
  DEFAULT_ENDPOINT,
  getSentrinelBrowser,
  initSentrinelBrowser,
  loadAnonymousId,
  resetSentrinelBrowser
};
