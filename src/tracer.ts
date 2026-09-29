import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface Span {
  id: string; // 16-hex span_id
  traceId: string; // 32-hex trace_id
  parentId?: string;
  name: string;
  kind?: string; // SERVER, CLIENT, INTERNAL, DB
  startTime: string; // ISO
  endTime?: string; // ISO
  durationMs: number;
  attributes: Record<string, any>;
  statusCode?: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
}

export interface TraceContext {
  traceId: string;
  rootSpanId: string;
  /**
   * The span that is running in *this* async context. Never mutated in place:
   * each span runs in its own copy of the store — see runInSpan().
   */
  currentSpanId: string;
  /** Shared by every copy of the store for one request. */
  spans: Span[];
  /**
   * The caller's span id, when this request arrived with `traceparent`.
   *
   * Distinct from `currentSpanId`, which differs per span. This one is fixed
   * for the request and is what the server span records as its parent, so a
   * mobile or browser client's span and the server work it caused join into
   * one tree instead of two roots sharing a trace id.
   */
  inboundSpanId?: string;
  /** Spans not kept because the trace hit MAX_SPANS_PER_TRACE. */
  droppedSpans?: number;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

/** Helper to generate 32-char hex traceId (OTLP format) */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Helper to generate 16-char hex spanId (OTLP format) */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

let lastUuidTimestamp = 0;
let uuidSeq = 0;

/**
 * Generates an RFC 9562 compliant UUID v7 identifier.
 * Embeds a 48-bit UNIX millisecond timestamp + monotonic sequence counter at the front of the 128-bit UUID.
 * Guarantees time-sortability and eliminates B-Tree index page splitting on database tables.
 */
export function generateUuidV7(): string {
  let timestamp = Date.now();
  if (timestamp === lastUuidTimestamp) {
    uuidSeq = (uuidSeq + 1) & 0xfff;
  } else {
    lastUuidTimestamp = timestamp;
    uuidSeq = 0;
  }

  const hexTs = timestamp.toString(16).padStart(12, "0");
  const verSeqHex = (0x7000 | uuidSeq).toString(16).padStart(4, "0");

  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0x3f) | 0x80; // Variant 10xx

  const restHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  return `${hexTs.slice(0, 8)}-${hexTs.slice(8, 12)}-${verSeqHex}-${restHex.slice(0, 4)}-${restHex.slice(4, 16)}`;
}

/**
 * Parses W3C traceparent (00-{traceId}-{parentSpanId}-01) or x-trace-id header from incoming Mobile/Web client requests.
 */
export function parseTraceParent(header: string | null | undefined): { traceId: string; parentSpanId?: string } | null {
  if (!header) return null;
  const trimmed = header.trim();

  // W3C format: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
  const w3cMatch = trimmed.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  if (w3cMatch) {
    return { traceId: w3cMatch[1].toLowerCase(), parentSpanId: w3cMatch[2].toLowerCase() };
  }

  // 32-char hex traceId
  if (/^[0-9a-f]{32}$/i.test(trimmed)) {
    return { traceId: trimmed.toLowerCase() };
  }

  // UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return { traceId: trimmed.replace(/-/g, "").toLowerCase() };
  }

  return null;
}

/**
 * Generates W3C compliant traceparent header string (00-{traceId}-{spanId}-01).
 */
export function createTraceParentHeader(traceId?: string, spanId?: string): string {
  const tId = traceId || generateTraceId();
  const sId = spanId || generateSpanId();
  return `00-${tId}-${sId}-01`;
}

/**
 * Client-side tracing helper for non-browser clients (scripts, CLIs, workers).
 *
 * In a web page use `@sentrinel/plugin/browser` instead: this module imports
 * node built-ins, and the browser SDK already propagates `traceparent` per
 * request on its patched `fetch`.
 *
 * @example
 * const tracer = createClientTracer({ clientName: "billing-cron" });
 * const res = await tracer.traceFetch("https://api.myapp.com/v1/checkout");
 */
export function createClientTracer(config: { clientName?: string } = {}) {
  const clientName = config.clientName || "web_client";

  return {
    getHeaders(existingHeaders: Record<string, string> = {}) {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      return {
        ...existingHeaders,
        traceparent: `00-${traceId}-${spanId}-01`,
        "x-trace-id": traceId,
        "x-consumer-id": clientName,
      };
    },
    traceFetch(input: string | URL | Request, init?: RequestInit) {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      const headers = new Headers(init?.headers);
      headers.set("traceparent", `00-${traceId}-${spanId}-01`);
      headers.set("x-trace-id", traceId);
      headers.set("x-consumer-id", clientName);
      return fetch(input, { ...init, headers });
    },
  };
}

/** Spans kept per trace. The ingest refuses a trace with more — all of it. */
export const MAX_SPANS_PER_TRACE = 1_000;

/** What the function running inside a span can do to it. */
export interface SpanHandle {
  setAttribute: (key: string, value: any) => void;
  /** Mark the span failed without throwing — for errors a caller handles. */
  setStatus: (status: "OK" | "ERROR", message?: string) => void;
  /** Empty outside a request, where nothing is recorded. */
  readonly spanId: string;
  readonly traceId: string;
}

const NOOP_HANDLE: SpanHandle = {
  setAttribute: () => {},
  setStatus: () => {},
  spanId: "",
  traceId: "",
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Run `fn` as a span, returning exactly what it returns.
 *
 * Two properties the old implementation lacked, both of which it needed:
 *
 *   1. **Each span runs in its own async context.** The parent used to be
 *      tracked by mutating `currentSpanId` on the request's shared store, so
 *      `Promise.all([a(), b()])` recorded `b` as a child of `a` — whichever
 *      started second saw the first one's id as "current". A fresh store per
 *      span (sharing the request's `spans` array) gives every branch its own
 *      notion of "current" that nothing else can overwrite.
 *
 *   2. **Synchronous functions stay synchronous.** `traced(fn)` used to return
 *      an async wrapper, so wrapping a sync helper changed its return type to a
 *      Promise and broke every caller that used the value directly. A promise
 *      result is finished when it settles; anything else is finished now.
 */
export function runInSpan<T>(
  name: string,
  attributes: Record<string, any>,
  kind: string,
  fn: (span: SpanHandle) => T
): T {
  const store = traceStorage.getStore();
  if (!store) return fn(NOOP_HANDLE);

  const spanId = generateSpanId();
  const started = Date.now();
  const startedPerf = nowMs();
  // Which tier this ran on, so the waterfall can say so.
  //
  // Inferred from the name rather than the OTel kind, because `kind` does not
  // answer the question: a CLIENT span is emitted by a phone, a browser and a
  // backend calling another service alike. An explicit `sentrinel.source` in
  // the caller's attributes always wins.
  const inferredSource = name.startsWith("db.")
    ? "database"
    : name.startsWith("http.client") || kind === "CLIENT"
      ? "outbound"
      : "backend";

  const spanAttrs: Record<string, any> = { "sentrinel.source": inferredSource, ...attributes };
  const spanObj: Span = {
    id: spanId,
    traceId: store.traceId,
    parentId: store.currentSpanId || undefined,
    name,
    kind,
    startTime: new Date(started).toISOString(),
    durationMs: 0,
    attributes: spanAttrs,
    statusCode: "OK",
  };

  const handle: SpanHandle = {
    setAttribute: (key, value) => {
      spanAttrs[key] = value;
    },
    setStatus: (status, message) => {
      spanObj.statusCode = status;
      if (message) spanObj.statusMessage = message;
    },
    spanId,
    traceId: store.traceId,
  };

  let finished = false;
  const finish = (failed: boolean, err?: any) => {
    if (finished) return;
    finished = true;
    const duration = Math.max(0, nowMs() - startedPerf);
    spanObj.durationMs = Math.round(duration * 100) / 100;
    spanObj.endTime = new Date(started + duration).toISOString();
    if (failed) {
      spanObj.statusCode = "ERROR";
      spanObj.statusMessage = err?.message || String(err);
      spanAttrs["error.type"] = err?.name || "Error";
      spanAttrs["error.stack"] = err?.stack || "";
    }
    // Bounded: a loop that opens a span per row would otherwise produce a
    // trace the ingest refuses outright, losing the spans that mattered too.
    if (store.spans.length < MAX_SPANS_PER_TRACE) store.spans.push(spanObj);
    else store.droppedSpans = (store.droppedSpans ?? 0) + 1;
  };

  let result: T;
  try {
    // A new store for this span: same trace, same span list, its own
    // "current span". Nested spans and logs written inside see this span as
    // their parent; concurrent siblings each see their own.
    result = traceStorage.run({ ...store, currentSpanId: spanId }, () => fn(handle));
  } catch (err) {
    finish(true, err);
    throw err;
  }

  if (isThenable(result)) {
    return (result as PromiseLike<unknown>).then(
      (value) => {
        finish(false);
        return value;
      },
      (err) => {
        finish(true, err);
        throw err;
      }
    ) as T;
  }
  finish(false);
  return result;
}

/**
 * Execute an async or synchronous function within an inner span.
 * Automatically inherits traceId and parentSpanId from the current HTTP request context.
 *
 * Always returns a Promise — use `traced()` to wrap a synchronous function
 * without making it async.
 *
 * @example
 * ```ts
 * const user = await traceSpan('db.query.findUser', async () => {
 *   return db.users.findById(id);
 * }, { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM users WHERE id = $1' });
 * ```
 */
export async function traceSpan<T>(
  name: string,
  fn: (span: SpanHandle) => Promise<T> | T,
  attributes?: Record<string, any>,
  kind?: string
): Promise<T>;
export async function traceSpan<T>(
  name: string,
  options: { kind?: string; attributes?: Record<string, any> } & Record<string, any>,
  fn: (span: SpanHandle) => Promise<T> | T
): Promise<T>;
export async function traceSpan<T>(
  name: string,
  second: any,
  third: any = {},
  fourth: string = "INTERNAL"
): Promise<T> {
  // Both call shapes are supported:
  //   traceSpan(name, fn, attributes?, kind?)
  //   traceSpan(name, { kind, ...attributes }, fn)
  // The second reads better and is what people reach for, so accepting only
  // the first turned an ordinary call into a TypeError at runtime.
  let fn: (span: SpanHandle) => Promise<T> | T;
  let attributes: Record<string, any>;
  let kind: string;

  if (typeof second === "function") {
    fn = second;
    attributes = third ?? {};
    kind = fourth;
  } else {
    fn = third;
    const { kind: k, attributes: attrs, ...rest } = second ?? {};
    attributes = { ...rest, ...(attrs ?? {}) };
    kind = k ?? "INTERNAL";
  }

  if (typeof fn !== "function") {
    throw new TypeError(
      `traceSpan("${name}") needs a function to run — call it as ` +
        `traceSpan(name, fn) or traceSpan(name, { kind }, fn).`
    );
  }

  return runInSpan(name, attributes, kind, fn);
}

/**
 * Super short 1-line alias for traceSpan.
 *
 * @example
 * const user = await tspan('db.findUser', () => db.find(id));
 */
export const tspan = traceSpan;

/**
 * Wrap any function to automatically trace it whenever called.
 * Infers function name automatically if a named function is passed!
 *
 * The wrapper returns what the function returns: a synchronous function stays
 * synchronous, an async one still returns its promise.
 *
 * @example
 * const getProducts = traced(async function getProducts() {
 *   return db.products.find();
 * });
 *
 * const fetchUser = traced('db.fetchUser', (id) => db.users.find(id));
 */
export function traced<T extends (...args: any[]) => any>(
  nameOrFn: string | T,
  fn?: T,
  attributes: Record<string, any> = {}
): T {
  const name = typeof nameOrFn === "string" ? nameOrFn : (nameOrFn as any).name || "tracedFunction";
  const targetFn = typeof nameOrFn === "function" ? nameOrFn : fn!;

  return function (this: unknown, ...args: any[]) {
    return runInSpan(name, attributes, "INTERNAL", () => targetFn.apply(this, args));
  } as unknown as T;
}

/**
 * Automatically instrument an entire service object or DB client!
 * Every method on the object will automatically generate an inner trace span
 * without any boilerplate code. Synchronous methods stay synchronous.
 *
 * @example
 * const db = traceObject(new DatabaseClient(), "db");
 * await db.findUser(123); // Automatically creates span 'db.findUser'!
 * await db.getLoans();    // Automatically creates span 'db.getLoans'!
 */
export function traceObject<T extends object>(target: T, namePrefix?: string): T {
  const prefix = namePrefix ? `${namePrefix}.` : "";

  return new Proxy(target, {
    get(obj, prop, receiver) {
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === "function" && typeof prop === "string" && prop !== "constructor") {
        const spanName = `${prefix}${prop}`;
        return (...args: any[]) => runInSpan(spanName, {}, "INTERNAL", () => val.apply(obj, args));
      }
      return val;
    },
  });
}

/**
 * Query values that are credentials, masked before a URL becomes a span
 * attribute — a pre-signed S3 URL or `?api_key=` on an outbound call is a
 * credential in a trace otherwise.
 */
function redactUrl(url: string): string {
  return url.replace(
    /([?&#])(token|key|api_?key|code|password|signature|sig|secret|access_token|refresh_token|id_token|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=([^&#]*)/gi,
    "$1$2=***"
  );
}

/**
 * Auto-traced fetch wrapper. Creates an HTTP client span for the outgoing call
 * and sends `traceparent` naming that span, so the service on the other end
 * continues this trace instead of starting its own.
 *
 * A `traceparent` the caller set is left alone. Outside a request there is no
 * trace to continue, so the call goes out unchanged.
 *
 * @example
 * const res = await sentrinelFetch("https://api.stripe.com/v1/charges", { method: "POST" });
 */
export async function sentrinelFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  let urlStr = "";
  let method = "GET";
  try {
    urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    method = init?.method?.toUpperCase() || (isRequest ? (input as Request).method : "GET");
  } catch {}

  let pathname = urlStr;
  try {
    pathname = new URL(urlStr).pathname;
  } catch {}

  return runInSpan(
    `http.client ${method} ${pathname}`,
    {
      "http.url": redactUrl(urlStr),
      "http.method": method,
      component: "http",
    },
    "CLIENT",
    async (span) => {
      let finalInit = init;
      if (span.spanId) {
        const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
        if (!headers.has("traceparent")) {
          headers.set("traceparent", `00-${span.traceId}-${span.spanId}-01`);
        }
        finalInit = { ...init, headers };
      }
      const res = await fetch(input, finalInit);
      span.setAttribute("http.status_code", res.status);
      if (res.status >= 500) span.setStatus("ERROR", `HTTP ${res.status}`);
      return res;
    }
  );
}
