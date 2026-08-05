import { Elysia } from "elysia";
import { MetricsCollector } from "./collector";
import { maskQueryParams, maskHeaders, maskBodyFields, truncateBody } from "./masking";
import type { SentrinelPluginOptions, RequestLogEntry } from "./types";
import { shouldCaptureLog } from "./sampling";
import { instrumentConsole, beginRequestLogContext, drainRequestLogs } from "./logs";
import {
  setLogSink,
  setLogEcho as applyLogEcho,
  setLogLevel as applyLogLevel,
  setCorrelationSource,
  enterRequestScope,
  currentRequestId,
  beginCanonicalScope,
  drainCanonicalFields,
  type LogRecord,
} from "./logger";
import {
  traceStorage,
  generateTraceId,
  generateSpanId,
  parseTraceParent,
  type TraceContext,
} from "./tracer";

export type { SentrinelPluginOptions, RequestLoggingOptions } from "./types";
export {
  traceSpan,
  tspan,
  traced,
  traceObject,
  sentrinelFetch,
  generateTraceId,
  generateSpanId,
  generateUuidV7,
  parseTraceParent,
  createTraceParentHeader,
  createClientTracer,
} from "./tracer";
export {
  getLogger,
  logger,
  withContext,
  addContext,
  currentContext,
  clearRequestScope,
  addRequestContext,
  setLogEcho,
  setLogLevel,
  type Logger,
  type LogRecord,
  type LogContext,
} from "./logger";
export { sentrinelExpressMiddleware } from "./express";
export { sentrinelNextMiddleware } from "./next";
export { createFlutterHeaderMap } from "./flutter";

/**
 * Sentrinel Elysia Plugin
 *
 * Instruments your Elysia application with API monitoring, metrics collection,
 * request logging, and error tracking. Data is sent to a Sentrinel API server
 * for visualization in the Sentrinel dashboard.
 *
 * @example
 * ```ts
 * import { sentrinelPlugin } from '@sentrinel/plugin';
 *
 * const app = new Elysia()
 *   .use(sentrinelPlugin({
 *     serverUrl: 'http://localhost:3001',
 *     appName: 'my-api',
 *     env: 'prod',
 *     requestLogging: {
 *       enabled: true,
 *       logRequestHeaders: true,
 *       logRequestBody: true,
 *       logResponseBody: true,
 *       maskHeaders: [/^authorization$/i, /^cookie$/i],
 *       maskBodyFields: [/^password$/i, /^token$/i],
 *     },
 *     consumerIdentifier: (ctx) => ctx.headers['x-consumer-id'],
 *   }))
 * ```
 */
export function sentrinelPlugin(options: SentrinelPluginOptions) {
  const collector = new MetricsCollector(options);
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65_536; // 64KB default
  const excludePatterns = (options.excludePaths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );

  return (app: any) => {
    collector.start();
    if (options.logCapture?.enabled) instrumentConsole(options.logCapture);

    // ─── Structured logging ────────────────────────────────────────────────
    //
    // Records from getLogger() go straight to the collector's buffer. The
    // correlation source lets the logger stamp every record with the active
    // request/trace/span without importing the plugin (which would cycle).
    if (options.logging?.echo) applyLogEcho(true);
    if (options.logging?.minLevel) applyLogLevel(options.logging.minLevel);
    setCorrelationSource(() => {
      const trace = traceStorage.getStore();
      return {
        requestId: currentRequestId(),
        traceId: trace?.traceId,
        // The span running right now, so a log written inside traceSpan()
        // attaches to that span rather than to the request as a whole.
        spanId: trace?.currentSpanId,
      };
    });
    const ownSink = (record: LogRecord) => {
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
    setLogSink(ownSink);
    if (options.debug) console.log("[sentrinel] Plugin initialized for", options.appName);

    app.onStop(async () => {
      await collector.stop();
    });

    // Request payloads, captured before anything else can consume the stream.
    //
    // This has to happen in `onRequest`, not `derive`. `derive` runs at the
    // transform stage — *after* Elysia has parsed the body — and once it has,
    // cloning yields an already-drained stream that reads back as "" with no
    // error thrown. Elysia parses eagerly for any route that declares a `body`
    // schema, which in a typed app is nearly every POST/PUT/PATCH, so the
    // payload silently went missing on exactly the requests most worth having
    // it for. See tests/raw-payload.test.ts.
    //
    // Reading from a *clone* keeps the original stream untouched for the
    // handler, so a route that verifies a raw signature still sees its bytes.
    // Keyed by the Request itself, weakly, so nothing is retained after the
    // response is done.
    const capturedPayloads = new WeakMap<Request, string>();
    if (options.requestLogging?.logRequestBody) {
      app.onRequest(async ({ request }: any) => {
        try {
          const text = await request.clone().text();
          if (text) capturedPayloads.set(request, text);
        } catch {
          // A body that cannot be cloned/read is not worth failing the request
          // over; telemetry is best-effort.
        }
      });
    }

    app.derive(async ({ request }: any) => {
      const requestLogId = crypto.randomUUID();
      if (options.logCapture?.enabled) beginRequestLogContext(requestLogId);

      const capturedPayload = capturedPayloads.get(request);

      // Open a trace context for this request.
      //
      // Without this, traceSpan()/traced() find no store and silently record
      // nothing — the entire tracing feature was inert for Elysia apps. An
      // incoming traceparent is honoured so a trace started upstream continues
      // through this service instead of being split in two.
      const incoming = parseTraceParent(request.headers.get("traceparent"));
      const traceCtx: TraceContext = {
        traceId: incoming?.traceId ?? generateTraceId(),
        rootSpanId: generateSpanId(),
        currentSpanId: "",
        spans: [],
      };
      traceCtx.currentSpanId = incoming?.parentSpanId ?? traceCtx.rootSpanId;
      // enterWith keeps the store for the rest of this request's async work,
      // which is what handlers run inside.
      traceStorage.enterWith(traceCtx);
      // Same for the request id, so every structured log written while handling
      // this request knows which request it belongs to.
      enterRequestScope(requestLogId, ownSink);
      // Collects business context for this request's canonical event.
      beginCanonicalScope();

      return {
        _sentrinelStartTime: performance.now(),
        _sentrinelRequestUrl: new URL(request.url),
        _sentrinelRequestLogId: requestLogId,
        _sentrinelTrace: traceCtx,
        _sentrinelTraceStart: new Date().toISOString(),
        _sentrinelReqPayload: capturedPayload,
      };
    });

    // Thrown exceptions never reach afterResponse with their stack intact —
    // Elysia has already turned them into a response by then. Capturing the
    // real Error here is what makes stack-trace fingerprinting (and therefore
    // issue grouping) work for genuine crashes rather than only for handlers
    // that happen to *return* an error-shaped object.
    app.onError((ctx: any) => {
      try {
        const err = ctx.error;
        if (err instanceof Error) {
          (ctx as any)._sentrinelError = {
            name: err.name,
            message: err.message,
            stack: err.stack,
          };
        }
      } catch {}
    });

    app.onAfterResponse(async (ctx: any) => {
      try {
        const startTime = (ctx as any)._sentrinelStartTime as number;
        const requestUrl = (ctx as any)._sentrinelRequestUrl as URL;
        if (!startTime || !requestUrl) return;

        const responseTime = performance.now() - startTime;
        const method = ctx.request.method.toUpperCase();
        const pathname = requestUrl.pathname;

        // Check if this path is excluded
        if (excludePatterns.some((p) => p.test(pathname))) return;

        // Determine the route pattern (use Elysia's matched route if available)
        const routePath = (ctx as any).route || pathname;

        const statusCode = typeof ctx.set?.status === "number"
          ? ctx.set.status
          : (ctx as any).response instanceof Response
            ? (ctx as any).response.status
            : 200;

        // Estimate sizes
        const requestSize = parseInt(ctx.request.headers.get("content-length") || "0", 10);
        let responseSize = 0;
        if (ctx.response !== null && ctx.response !== undefined) {
          if (typeof ctx.response === "string") {
            responseSize = new TextEncoder().encode(ctx.response).byteLength;
          } else if (typeof ctx.response === "object") {
            try {
              responseSize = new TextEncoder().encode(JSON.stringify(ctx.response)).byteLength;
            } catch {}
          }
        }

        // Get consumer identifier
        let consumerIdentifier: string | null | undefined = null;
        if (typeof options.consumerIdentifier === "function") {
          try {
            // Hand the resolver an explicit, field-by-field view rather than
            // the raw context. Passing the whole context to a function Elysia
            // cannot inspect makes it assume every field is needed — including
            // the request payload — so it eagerly parses every request and
            // consumes the single-use stream, breaking handlers that read the
            // raw request themselves. Naming the fields keeps the payload out
            // of what Elysia infers as used. A resolver that needs the parsed
            // payload is the rare exception and can read it from `request`.
            const safeCtx = {
              request: ctx.request,
              headers: ctx.headers,
              set: ctx.set,
              query: ctx.query,
              params: ctx.params,
              store: ctx.store,
              response: ctx.response,
            };
            consumerIdentifier = options.consumerIdentifier(safeCtx);
          } catch {}
        } else if (typeof options.consumerIdentifier === "string") {
          // Header-name shorthand, matching the Express/Next adapters.
          consumerIdentifier = ctx.request.headers.get(options.consumerIdentifier.toLowerCase());
        }

        // Record metrics
        collector.recordRequest({
          method,
          path: routePath,
          statusCode,
          responseTime,
          requestSize,
          responseSize,
          consumerIdentifier,
        });

        const requestLogId = (ctx as any)._sentrinelRequestLogId as string;
        const traceId = (ctx as any)._sentrinelTrace?.traceId as string | undefined;
        // Drained once, here: both the error row and the request row want it,
        // and draining twice would leave the second one empty.
        const canonicalFields = drainCanonicalFields();

        // Record errors
        if (statusCode >= 400) {
          let errorMessage: string | undefined;
          let errorType: string | undefined;
          let stackTrace: string | undefined;

          // A real thrown Error (captured in onError) always wins — it is the
          // only source with a usable stack trace.
          const thrown = (ctx as any)._sentrinelError as
            | { name: string; message: string; stack?: string }
            | undefined;

          if (thrown) {
            errorType = thrown.name;
            errorMessage = thrown.message;
            stackTrace = thrown.stack;
          } else if (ctx.response && typeof ctx.response === "object") {
            const resp = ctx.response as any;
            errorMessage = resp.message || resp.error || undefined;
            errorType = resp.name || resp.type || undefined;
            stackTrace = resp.stack || undefined;
          } else if (typeof ctx.response === "string") {
            errorMessage = ctx.response;
          }

          collector.recordError({
            method,
            path: routePath,
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
            attributes: canonicalFields,
          });
        }

        // Record request log (if enabled), applying head sampling.
        //
        // Metrics above are already recorded, so counters stay exact no
        // matter the sample rate. Errors and slow requests always pass.
        // Drain app logs captured while handling this request.
        const drained = options.logCapture?.enabled
          ? drainRequestLogs()
          : { logs: [], dropped: 0 };
        const hasErrorLogs = drained.logs.some((l) => l.level === "error");
        if (drained.logs.length) collector.recordAppLogs(drained.logs);

        // ─── Ship the trace ────────────────────────────────────────────────
        //
        // Spans collected by traceSpan()/traced() during the handler, plus a
        // root span for the HTTP request itself so the waterfall always has
        // something to nest under.
        //
        // Emitted for EVERY request, not only ones that opened child spans.
        // Logs and error records both carry this trace id, so skipping the
        // trace would leave them pointing at something that does not exist —
        // "open the waterfall" would 404. A request with no child spans still
        // has a real trace: the HTTP span itself.
        const traceCtx = (ctx as any)._sentrinelTrace as TraceContext | undefined;
        if (traceCtx) {
          const traceStart = (ctx as any)._sentrinelTraceStart as string;
          const startMs = new Date(traceStart).getTime();
          const rootSpan = {
            id: traceCtx.rootSpanId,
            traceId: traceCtx.traceId,
            parentId: null,
            name: `${method} ${routePath}`,
            kind: "SERVER",
            startTime: traceStart,
            endTime: new Date(startMs + responseTime).toISOString(),
            durationMs: Math.round(responseTime * 100) / 100,
            statusCode: statusCode >= 500 ? "ERROR" : "OK",
            attributes: {
              "http.method": method,
              "http.route": routePath,
              "http.status_code": statusCode,
              ...(consumerIdentifier ? { "sentrinel.consumer": consumerIdentifier } : {}),
            },
          };
          collector.recordTrace({
            traceId: traceCtx.traceId,
            requestLogId: requestLogId,
            name: `${method} ${routePath}`,
            startTime: traceStart,
            endTime: new Date(startMs + responseTime).toISOString(),
            durationMs: Math.round(responseTime * 100) / 100,
            statusCode,
            spans: [rootSpan, ...traceCtx.spans],
          });
        }

        if (options.requestLogging?.enabled) {
          const decision = shouldCaptureLog(
            statusCode,
            responseTime,
            options.requestLogging
          );
          // A request that emitted error-level logs is always kept, even if
          // it returned 200 and would otherwise be sampled out.
          if (!decision.capture && !hasErrorLogs) return; // sampled out

          const entry: RequestLogEntry = {
            id: requestLogId,
            method,
            // The row keeps the real URL; `route` is what anything grouping
            // should key on. Sending only `pathname` made the API register one
            // endpoint per id.
            path: pathname,
            route: routePath,
            statusCode,
            responseTime: Math.round(responseTime * 100) / 100,
            requestSize,
            responseSize,
            env: options.env || "dev",
            consumerIdentifier,
            timestamp: new Date().toISOString(),
            sampleRate: hasErrorLogs ? 1 : decision.sampleRate,
            // Links the row to its trace so the Trace tab can resolve it.
            traceId,
            // Whatever the handler attached via addRequestContext() — the
            // business half of the canonical event.
            attributes: canonicalFields,
          };

          // Log headers (masked)
          if (options.requestLogging.logRequestHeaders) {
            const rawHeaders: Record<string, string> = {};
            ctx.request.headers.forEach((value: string, key: string) => {
              rawHeaders[key] = value;
            });
            entry.requestHeaders = options.requestLogging.maskHeaders
              ? maskHeaders(rawHeaders, options.requestLogging.maskHeaders)
              : rawHeaders;
          }

          // Log query params (masked)
          const queryObj: Record<string, string> = {};
          requestUrl.searchParams.forEach((value, key) => {
            queryObj[key] = value;
          });
          if (Object.keys(queryObj).length > 0) {
            entry.queryParams = options.requestLogging.maskQueryParams
              ? maskQueryParams(queryObj, options.requestLogging.maskQueryParams)
              : queryObj;
          }

          // Log the request payload (masked + truncated).
          //
          // The payload was captured in the derive hook, from a clone of the
          // request, before the handler ran — see there for why it must not be
          // read from the context here. `_sentrinelReqPayload` is undefined
          // unless logging it was enabled, so this whole block is inert
          // otherwise.
          const parsedPayload = (ctx as any)._sentrinelReqPayload as
            | string
            | undefined;
          if (parsedPayload !== undefined && parsedPayload !== null) {
            try {
              const raw = parsedPayload;
              if (raw && raw !== "{}") {
                let maskedBody = options.requestLogging.maskBodyFields
                  ? maskBodyFields(raw, options.requestLogging.maskBodyFields)
                  : raw;
                if (typeof maskedBody === "object") maskedBody = JSON.stringify(maskedBody);
                entry.requestBody = truncateBody(maskedBody, maxBodySize);
              }
            } catch {}
          }

          // Log the response payload (masked + truncated)
          if (options.requestLogging.logResponseBody && ctx.response !== null && ctx.response !== undefined) {
            try {
              let bodyText: string;
              if (typeof ctx.response === "string") {
                bodyText = ctx.response;
              } else if (typeof ctx.response === "object") {
                bodyText = JSON.stringify(ctx.response);
              } else {
                bodyText = String(ctx.response);
              }
              let maskedBody = options.requestLogging.maskBodyFields
                ? maskBodyFields(bodyText, options.requestLogging.maskBodyFields)
                : bodyText;
              if (typeof maskedBody === "object") maskedBody = JSON.stringify(maskedBody);
              entry.responseBody = truncateBody(maskedBody, maxBodySize);
            } catch {}
          }

          // Error message
          if (statusCode >= 400 && ctx.response) {
            if (typeof ctx.response === "object" && (ctx.response as any).message) {
              entry.errorMessage = (ctx.response as any).message;
            }
          }

          collector.recordRequestLog(entry);
        }

      } catch (err) {
        if (options.debug) console.error("[sentrinel] Error in afterResponse hook:", err);
      }
    });

    return app;
  };
}

// ─── HTTP Status Messages ───────────────────────────────────────────────────────

function getStatusMessage(code: number): string {
  const messages: Record<number, string> = {
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
  return messages[code] || `HTTP ${code}`;
}
