// ─── The request lifecycle every server adapter shares ──────────────────────
//
// Elysia, Express, Next and Bun each used to carry their own copy of "record a
// request": four near-identical blocks that had drifted apart. Only Elysia
// opened a trace context, so `traceSpan()` recorded nothing under the other
// three and their errors carried trace ids that pointed at nothing. Only Elysia
// masked query strings. Next never recorded a response at all. Each fix had to
// be made four times and usually was made once.
//
// Now an adapter's job is only what is genuinely framework-specific — where
// the status, the route and the body live — and everything that turns those
// facts into telemetry happens here, once:
//
//   begin(request facts)  → a RequestState: ids, trace context, log scopes
//   run(state, handler)   → the handler, inside every scope (tracing, logs)
//   finish(state, outcome)→ metrics, error, request log, app logs, trace

import { MetricsCollector } from "./collector";
import {
  traceStorage,
  generateTraceId,
  generateSpanId,
  parseTraceParent,
  type TraceContext,
} from "./tracer";
import { maskHeaders, maskQueryParams, maskBodyFields, truncateBody } from "./masking";
import { shouldCaptureLog } from "./sampling";
import {
  instrumentConsole,
  createRequestLogContext,
  runWithRequestLogContext,
  enterRequestLogContext,
  drainRequestLogs,
  type RequestLogContextHandle,
} from "./logs";
import {
  setLogSink,
  setLogEcho,
  setLogLevel,
  setCorrelationSource,
  currentRequestId,
  runInRequestScope,
  enterRequestScope,
  createCanonicalScope,
  runInCanonicalScope,
  enterCanonicalScope,
  drainCanonicalScope,
  type CanonicalScope,
  type LogRecord,
  type LogSink,
} from "./logger";
import { clientIp, clientCountry, requestHost } from "./client";
import {
  resolveConsumer,
  type ConsumerIdentity,
  type RequestLogEntry,
  type SentrinelPluginOptions,
} from "./types";

/** Who the browser SDK says is calling — `guest:<device>` or the identified user. */
export const CONSUMER_HEADER = "x-sentrinel-consumer";
/** The browser's persisted anonymous id. */
export const DEVICE_HEADER = "x-sentrinel-device";

const MAX_HEADER_VALUE = 255;

/** Read one request header by lower-case name. */
export type HeaderGetter = (name: string) => string | null | undefined;

export interface RequestState {
  requestLogId: string;
  startPerf: number;
  startISO: string;
  method: string;
  url: URL;
  trace: TraceContext;
  canonical: CanonicalScope;
  logCtx?: RequestLogContextHandle;
  /** A trusted `x-sentrinel-consumer`, used only when the resolver finds nobody. */
  headerConsumer?: string;
  /** `x-sentrinel-device`, recorded as the `device.id` attribute. */
  deviceId?: string;
  origin: { clientIp?: string; country?: string; host?: string };
}

/** A body as the adapter found it: text it read, or a value the framework parsed. */
export interface CapturedBody {
  text?: string;
  value?: unknown;
  /** Capture stopped at the byte limit. */
  truncated?: boolean;
  /** The full size, when known (content-length). */
  totalBytes?: number;
  contentType?: string | null;
}

export interface RequestOutcome {
  statusCode: number;
  /** The matched route pattern. Falls back to the path, which the collector normalises. */
  route?: string;
  /** A thrown error — the only source of a real stack trace. */
  error?: { name: string; message: string; stack?: string };
  /** Whatever `consumerIdentifier` resolved to. */
  consumer?: string | ConsumerIdentity | null;
  requestSize?: number;
  responseSize?: number;
  /** Called only when headers are being logged. */
  requestHeaders?: () => Record<string, string>;
  requestBody?: CapturedBody;
  responseBody?: CapturedBody;
}

export interface ServerInstrumentation {
  readonly collector: MetricsCollector;
  readonly options: SentrinelPluginOptions;
  /** Byte limit for body capture. */
  readonly maxBodySize: number;
  isExcludedPath(pathname: string): boolean;
  begin(method: string, url: URL, header: HeaderGetter): RequestState;
  /** Run `fn` inside the request's scopes; they end when it does. */
  run<T>(state: RequestState, fn: () => T): T;
  /** Enter the request's scopes for the rest of this async execution (Elysia's hooks). */
  enter(state: RequestState): void;
  /** Resolve the configured consumer from a header-name shorthand. */
  consumerFromHeader(header: HeaderGetter): string | null | undefined;
  finish(state: RequestState, outcome: RequestOutcome): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** The correlation every adapter installs: request, trace and span from context. */
function correlationFromContext() {
  const trace = traceStorage.getStore();
  return {
    requestId: currentRequestId(),
    traceId: trace?.traceId,
    // The span running right now, so a log written inside traceSpan()
    // attaches to that span rather than to the request as a whole.
    spanId: trace?.currentSpanId,
  };
}

function compileExcludes(paths: SentrinelPluginOptions["excludePaths"]): RegExp[] {
  return (paths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );
}

/** A `Headers`-shaped view over a getter, for the helpers in client.ts. */
function headersView(header: HeaderGetter): Headers {
  return { get: (name: string) => header(name) ?? null } as unknown as Headers;
}

/**
 * Validate `x-sentrinel-consumer`.
 *
 * A header a browser sets is a claim, so it is only ever a fallback for a
 * request the app's own resolver could not attribute, and only in a shape that
 * impersonates nobody: `guest:<device id>`, or whatever the app explicitly
 * trusts through `consumerHeaderPattern`.
 */
export function trustedHeaderConsumer(
  value: string | null | undefined,
  pattern?: RegExp
): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v || v.length > MAX_HEADER_VALUE) return undefined;
  // Control characters have no business in an identifier and would corrupt a
  // log line or a CSV export.
  if (/[\u0000-\u001f\u007f]/.test(v)) return undefined;
  if (/^guest:[A-Za-z0-9_.:-]{1,249}$/.test(v)) return v;
  if (pattern) {
    pattern.lastIndex = 0;
    if (pattern.test(v)) return v;
  }
  return undefined;
}

export function trustedDeviceId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v || v.length > MAX_HEADER_VALUE) return undefined;
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? v : undefined;
}

export function getStatusMessage(code: number): string {
  return STATUS_MESSAGES[code] || `HTTP ${code}`;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** A status set as a name (`set.status = "Not Found"`), back to its number. */
export function statusFromName(name: string): number | undefined {
  const wanted = name.trim().toLowerCase();
  for (const [code, message] of Object.entries(STATUS_MESSAGES)) {
    if (message.toLowerCase() === wanted) return Number(code);
  }
  return undefined;
}

export function errorShape(err: unknown): { name: string; message: string; stack?: string } | undefined {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") {
      return {
        name: typeof e.name === "string" ? e.name : "Error",
        message: e.message,
        stack: typeof e.stack === "string" ? e.stack : undefined,
      };
    }
  }
  if (err === undefined || err === null) return undefined;
  return { name: "Error", message: String(err) };
}

/** Text of a captured body, for logging and for reading an error message out of it. */
function bodyText(body: CapturedBody | undefined): string | undefined {
  if (!body) return undefined;
  if (typeof body.text === "string") return body.text;
  const v = body.value;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof Response !== "undefined" && v instanceof Response) return undefined;
    // Buffers and typed arrays are binary: nothing to log as text.
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return undefined;
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return String(v);
}

/** Masked and truncated, ready for a request log row. */
function renderBody(
  body: CapturedBody | undefined,
  maxBodySize: number,
  patterns: (string | RegExp)[] | undefined
): string | undefined {
  if (!body) return undefined;
  try {
    let masked: string | undefined;
    const v = body.value;
    if (
      body.text === undefined &&
      v &&
      typeof v === "object" &&
      !(ArrayBuffer.isView(v) || v instanceof ArrayBuffer) &&
      !(typeof Response !== "undefined" && v instanceof Response)
    ) {
      // A parsed object is masked structurally — no text heuristics needed.
      masked = JSON.stringify(maskBodyFields(v, patterns));
    } else {
      const text = bodyText(body);
      if (!text) return undefined;
      masked = maskBodyFields(text, patterns, body.contentType ?? undefined) as string;
    }
    if (!masked || masked === "{}") return undefined;
    if (body.truncated) {
      // Capture already stopped at the limit; say so, with the real size
      // when the sender declared one.
      const marked = masked.length > maxBodySize ? masked.slice(0, maxBodySize) : masked;
      return `${marked}... [truncated${body.totalBytes ? `, ${body.totalBytes} bytes total` : ""}]`;
    }
    return truncateBody(masked, maxBodySize);
  } catch {
    return undefined;
  }
}

/** What an error-status response said about itself, when the handler threw nothing. */
function errorFromBody(body: CapturedBody | undefined): {
  message?: string;
  type?: string;
  stack?: string;
} {
  if (!body) return {};
  const v = body.value;
  if (v && typeof v === "object" && !(typeof Response !== "undefined" && v instanceof Response)) {
    const o = v as Record<string, any>;
    return {
      message: typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : undefined,
      type: typeof o.name === "string" ? o.name : typeof o.type === "string" ? o.type : undefined,
      stack: typeof o.stack === "string" ? o.stack : undefined,
    };
  }
  const text = bodyText(body);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return {
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : undefined,
        type: typeof parsed.name === "string" ? parsed.name : typeof parsed.type === "string" ? parsed.type : undefined,
      };
    }
  } catch {
    // Not JSON: the text itself is the message.
  }
  return { message: text.slice(0, 500) };
}

export function createServerInstrumentation(
  options: SentrinelPluginOptions,
  adapter: string
): ServerInstrumentation {
  const collector = new MetricsCollector(options);
  collector.start();
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65_536;
  const excludes = compileExcludes(options.excludePaths);

  if (options.logCapture?.enabled) instrumentConsole(options.logCapture);

  // ─── Structured logging ────────────────────────────────────────────────
  //
  // Records from getLogger() go straight to the collector's buffer. The
  // correlation source lets the logger stamp every record with the active
  // request/trace/span without importing the plugin (which would cycle).
  if (options.logging?.echo) setLogEcho(true);
  if (options.logging?.minLevel) setLogLevel(options.logging.minLevel);
  setCorrelationSource(correlationFromContext);
  const sink: LogSink = (record: LogRecord) => {
    collector.recordAppLogs([
      {
        timestamp: record.timestamp,
        level: record.level,
        message: record.message,
        category: record.category,
        attributes: record.attributes,
        requestId: record.requestId,
        traceId: record.traceId,
        spanId: record.spanId,
      },
    ]);
  };
  // Logs written outside a request go to the first plugin that registered.
  setLogSink(sink);
  if (options.debug) console.log(`[sentrinel] ${adapter} instrumentation initialized for`, options.appName);

  const consumerFromHeader = (header: HeaderGetter) =>
    typeof options.consumerIdentifier === "string"
      ? header(options.consumerIdentifier.toLowerCase())
      : undefined;

  const begin = (method: string, url: URL, header: HeaderGetter): RequestState => {
    const requestLogId = crypto.randomUUID();
    // An incoming traceparent is honoured so a trace started upstream — a
    // browser, a phone, another service — continues here instead of being
    // split in two.
    const incoming =
      parseTraceParent(header("traceparent")) ??
      parseTraceParent(header("x-trace-id")) ??
      parseTraceParent(header("x-request-id"));
    const rootSpanId = generateSpanId();
    const trace: TraceContext = {
      traceId: incoming?.traceId ?? generateTraceId(),
      rootSpanId,
      // Child spans hang off this request's own server span. Pointing them at
      // the caller's span instead would make the server span a sibling of the
      // work it performed rather than its parent.
      currentSpanId: rootSpanId,
      spans: [],
      inboundSpanId: incoming?.parentSpanId,
    };

    let origin: RequestState["origin"] = {};
    try {
      const view = headersView(header);
      origin = { clientIp: clientIp(view), country: clientCountry(view), host: requestHost(view) };
    } catch {
      // Telemetry is best-effort; never fail a request over provenance.
    }

    return {
      requestLogId,
      startPerf: performance.now(),
      startISO: new Date().toISOString(),
      method: (method || "GET").toUpperCase(),
      url,
      trace,
      canonical: createCanonicalScope(),
      logCtx: options.logCapture?.enabled ? createRequestLogContext(requestLogId) : undefined,
      headerConsumer: trustedHeaderConsumer(header(CONSUMER_HEADER), options.consumerHeaderPattern),
      deviceId: trustedDeviceId(header(DEVICE_HEADER)),
      origin,
    };
  };

  const run = <T>(state: RequestState, fn: () => T): T =>
    traceStorage.run(state.trace, () =>
      runInRequestScope(state.requestLogId, sink, () =>
        runInCanonicalScope(state.canonical, () =>
          state.logCtx ? runWithRequestLogContext(state.logCtx, fn) : fn()
        )
      )
    );

  const enter = (state: RequestState): void => {
    // enterWith keeps the store for the rest of this request's async work,
    // which is what Elysia's handlers run inside — it has no single call to
    // wrap.
    traceStorage.enterWith(state.trace);
    enterRequestScope(state.requestLogId, sink);
    enterCanonicalScope(state.canonical);
    if (state.logCtx) enterRequestLogContext(state.logCtx);
  };

  const finish = (state: RequestState, outcome: RequestOutcome): void => {
    const responseTime = performance.now() - state.startPerf;
    const method = state.method;
    const pathname = state.url.pathname;
    const route = outcome.route || pathname;
    const statusCode = outcome.statusCode || 200;

    // Who called. The app's own resolver always wins; the browser's header is
    // a fallback for traffic nothing else could attribute.
    const resolved = resolveConsumer(outcome.consumer ?? null);
    const consumerIdentifier = resolved.identifier ?? state.headerConsumer ?? null;
    const consumerName = resolved.identifier ? resolved.name : undefined;
    const consumerGroup = resolved.identifier ? resolved.group : undefined;

    const requestSize = outcome.requestSize ?? 0;
    const responseSize = outcome.responseSize ?? 0;

    collector.recordRequest({
      method,
      path: route,
      statusCode,
      responseTime,
      requestSize,
      responseSize,
      consumerIdentifier,
      consumerName,
      consumerGroup,
    });

    // Drained once, here: the error row, the request row and the trace all
    // want the same fields, and draining twice would leave the rest empty.
    const canonical = drainCanonicalScope(state.canonical);
    const attributes =
      canonical || state.deviceId
        ? { ...(canonical ?? {}), ...(state.deviceId ? { "device.id": state.deviceId } : {}) }
        : undefined;

    const requestLogId = state.requestLogId;
    const traceId = state.trace.traceId;

    // ─── Error ─────────────────────────────────────────────────────────
    let errorMessage: string | undefined;
    if (statusCode >= 400 || outcome.error) {
      let errorType: string | undefined;
      let stackTrace: string | undefined;
      if (outcome.error) {
        // A real thrown Error always wins — it is the only source with a
        // usable stack trace, which is what issue grouping fingerprints.
        errorType = outcome.error.name;
        errorMessage = outcome.error.message;
        stackTrace = outcome.error.stack;
      } else {
        const fromBody = errorFromBody(outcome.responseBody);
        errorType = fromBody.type;
        errorMessage = fromBody.message;
        stackTrace = fromBody.stack;
      }
      collector.recordError({
        method,
        path: route,
        statusCode,
        statusMessage: getStatusMessage(statusCode),
        errorType,
        errorMessage,
        stackTrace,
        consumerIdentifier,
        timestamp: new Date().toISOString(),
        // The links that let an issue occurrence open the request that
        // produced it, and that request's waterfall.
        requestLogId,
        traceId,
        attributes,
      });
    }

    // ─── Console lines captured during the request ─────────────────────
    const drained = state.logCtx ? drainRequestLogs(state.logCtx) : { logs: [], dropped: 0 };
    const hasErrorLogs = drained.logs.some((l) => l.level === "error");
    // Stamp the caller onto every line written while handling this request,
    // so "everything this user did" is one query rather than a join through a
    // request row that may have aged out of retention.
    if (drained.logs.length) {
      collector.recordAppLogs(
        consumerIdentifier ? drained.logs.map((l) => ({ ...l, consumerIdentifier })) : drained.logs
      );
    }

    // ─── Trace ─────────────────────────────────────────────────────────
    //
    // Emitted for EVERY request, not only ones that opened child spans. Logs
    // and error records both carry this trace id, so skipping the trace would
    // leave them pointing at something that does not exist. A request with no
    // child spans still has a real trace: the HTTP span itself.
    const startMs = new Date(state.startISO).getTime();
    const endTime = new Date(startMs + responseTime).toISOString();
    const durationMs = Math.round(responseTime * 100) / 100;
    const trace = state.trace;
    collector.recordTrace({
      traceId,
      requestLogId,
      name: `${method} ${route}`,
      startTime: state.startISO,
      endTime,
      durationMs,
      statusCode,
      spans: [
        {
          id: trace.rootSpanId,
          traceId,
          // The caller's span, when one arrived on `traceparent`: with it, a
          // browser or phone span is the root and the gap between it and this
          // span is the network — usually the part being argued about.
          parentId: trace.inboundSpanId ?? null,
          name: `${method} ${route}`,
          kind: "SERVER",
          startTime: state.startISO,
          endTime,
          durationMs,
          statusCode: statusCode >= 500 || outcome.error ? "ERROR" : "OK",
          ...(outcome.error ? { statusMessage: outcome.error.message } : {}),
          attributes: {
            "sentrinel.source": "backend",
            "http.method": method,
            "http.route": route,
            "http.status_code": statusCode,
            ...(consumerIdentifier ? { "sentrinel.consumer": consumerIdentifier } : {}),
            ...(state.deviceId ? { "device.id": state.deviceId } : {}),
            ...(trace.droppedSpans ? { "sentrinel.dropped_spans": trace.droppedSpans } : {}),
          },
        },
        ...trace.spans,
      ],
    });

    // ─── Request log ───────────────────────────────────────────────────
    //
    // Metrics above are already recorded, so counters stay exact no matter
    // the sample rate. Errors and slow requests always pass, and so does a
    // request that wrote an error-level log line.
    const logging = options.requestLogging;
    if (!logging?.enabled) return;
    const decision = shouldCaptureLog(statusCode, responseTime, logging);
    if (!decision.capture && !hasErrorLogs) return;

    const entry: RequestLogEntry = {
      id: requestLogId,
      method,
      // The row keeps the real URL; `route` is what anything grouping should
      // key on. Sending only `pathname` made the API register one endpoint
      // per id.
      path: pathname,
      route,
      statusCode,
      responseTime: durationMs,
      requestSize,
      responseSize,
      env: options.env || "dev",
      consumerIdentifier,
      timestamp: state.startISO,
      sampleRate: hasErrorLogs ? 1 : decision.sampleRate,
      traceId,
      attributes,
      ...state.origin,
    };

    // Masked with the built-in deny-list whether or not the app added
    // patterns of its own: a default configuration must not ship
    // `Authorization` headers or session cookies.
    if (logging.logRequestHeaders && outcome.requestHeaders) {
      try {
        entry.requestHeaders = maskHeaders(outcome.requestHeaders(), logging.maskHeaders);
      } catch {}
    }

    const query: Record<string, string> = {};
    state.url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    if (Object.keys(query).length) entry.queryParams = maskQueryParams(query, logging.maskQueryParams);

    if (logging.logRequestBody) {
      entry.requestBody = renderBody(outcome.requestBody, maxBodySize, logging.maskBodyFields);
    }
    if (logging.logResponseBody) {
      entry.responseBody = renderBody(outcome.responseBody, maxBodySize, logging.maskBodyFields);
    }
    if (statusCode >= 400 && errorMessage) entry.errorMessage = errorMessage;

    collector.recordRequestLog(entry);
  };

  return {
    collector,
    options,
    maxBodySize,
    isExcludedPath: (pathname) => excludes.some((p) => p.test(pathname)),
    begin,
    run,
    enter,
    consumerFromHeader,
    finish,
    flush: () => collector.flush(),
    stop: () => collector.stop(),
  };
}

/** Node-style headers (`IncomingMessage.headers`) as a flat string map. */
export function flattenNodeHeaders(
  headers: Record<string, string | string[] | number | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** A header getter over Node-style headers. */
export function nodeHeaderGetter(
  headers: Record<string, string | string[] | number | undefined>
): HeaderGetter {
  return (name) => {
    const v = headers[name.toLowerCase()];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : String(v);
  };
}
