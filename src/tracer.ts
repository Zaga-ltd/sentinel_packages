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
  currentSpanId: string;
  spans: Span[];
  /**
   * The caller's span id, when this request arrived with `traceparent`.
   *
   * Distinct from `currentSpanId`, which moves as spans open and close. This
   * one is fixed for the request and is what the server span records as its
   * parent, so a mobile or browser client's span and the server work it caused
   * join into one tree instead of two roots sharing a trace id.
   */
  inboundSpanId?: string;
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
 * Client-side Web / Mobile RUM tracing helper.
 * Instruments outgoing client HTTP requests with W3C traceparent and consumer headers,
 * allowing end-to-end distributed tracing originating from Mobile Apps and Web Frontends.
 *
 * @example
 * const tracer = createClientTracer({ clientName: "mobile_ios_v4" });
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

/**
 * Execute an async or synchronous function within an inner span.
 * Automatically inherits traceId and parentSpanId from the current HTTP request context.
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
  fn: (span: { setAttribute: (key: string, value: any) => void }) => Promise<T> | T,
  attributes?: Record<string, any>,
  kind?: string
): Promise<T>;
export async function traceSpan<T>(
  name: string,
  options: { kind?: string; attributes?: Record<string, any> } & Record<string, any>,
  fn: (span: { setAttribute: (key: string, value: any) => void }) => Promise<T> | T
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
  let fn: (span: { setAttribute: (key: string, value: any) => void }) => Promise<T> | T;
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

  const store = traceStorage.getStore();
  if (!store) {
    // If called outside an active request context, run directly
    return fn({ setAttribute: () => {} });
  }

  const spanId = generateSpanId();
  const parentId = store.currentSpanId;
  const startTime = new Date();
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

  const spanAttrs: Record<string, any> = {
    "sentrinel.source": inferredSource,
    ...attributes,
  };

  const spanObj: Span = {
    id: spanId,
    traceId: store.traceId,
    parentId,
    name,
    kind,
    startTime: startTime.toISOString(),
    durationMs: 0,
    attributes: spanAttrs,
    statusCode: "OK",
  };

  const setAttribute = (key: string, value: any) => {
    spanAttrs[key] = value;
  };

  // Temporarily set this span as current for any nested inner spans
  const parentSpanId = store.currentSpanId;
  store.currentSpanId = spanId;

  try {
    const result = await fn({ setAttribute });
    const endTime = new Date();
    spanObj.endTime = endTime.toISOString();
    spanObj.durationMs = Math.round((endTime.getTime() - startTime.getTime()) * 100) / 100;
    store.spans.push(spanObj);
    return result;
  } catch (err: any) {
    const endTime = new Date();
    spanObj.endTime = endTime.toISOString();
    spanObj.durationMs = Math.round((endTime.getTime() - startTime.getTime()) * 100) / 100;
    spanObj.statusCode = "ERROR";
    spanObj.statusMessage = err?.message || String(err);
    spanObj.attributes["error.type"] = err?.name || "Error";
    spanObj.attributes["error.stack"] = err?.stack || "";
    store.spans.push(spanObj);
    throw err;
  } finally {
    store.currentSpanId = parentSpanId;
  }
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

  return (async (...args: any[]) => {
    return traceSpan(name, () => targetFn(...args), attributes);
  }) as unknown as T;
}

/**
 * Automatically instrument an entire service object or DB client!
 * Every method on the object will automatically generate an inner trace span without any boilerplate code.
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
        return (...args: any[]) => traceSpan(spanName, () => val.apply(obj, args));
      }
      return val;
    },
  });
}

/**
 * Auto-traced fetch wrapper. Automatically creates an HTTP client span for outgoing HTTP calls.
 *
 * @example
 * const res = await sentrinelFetch("https://api.stripe.com/v1/charges", { method: "POST" });
 */
export async function sentrinelFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  let urlStr = "";
  let method = "GET";
  try {
    urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    method = init?.method?.toUpperCase() || (input instanceof Request ? input.method : "GET");
  } catch {}

  let pathname = urlStr;
  try {
    pathname = new URL(urlStr).pathname;
  } catch {}

  return traceSpan(
    `http.client ${method} ${pathname}`,
    async () => fetch(input, init),
    {
      "http.url": urlStr,
      "http.method": method,
      "component": "http",
    },
    "CLIENT"
  );
}
