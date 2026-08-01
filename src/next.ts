// ─── Sentrinel Next.js Middleware ─────────────────────────────────────────────
// Next.js App Router / Pages Router / API Routes telemetry middleware.
//
// Usage in middleware.ts (App Router):
//   import { sentrinelNextMiddleware } from "@sentrinel/plugin/next";
//   export const middleware = sentrinelNextMiddleware({ ... });
//   export const config = { matcher: "/api/:path*" };
//
// Usage in API routes (pages router):
//   import { withSentrinel } from "@sentrinel/plugin/next";
//   export default withSentrinel(options, handler);

import { MetricsCollector } from "./collector";
import { parseTraceParent, generateTraceId, generateSpanId } from "./tracer";
import { maskHeaders } from "./masking";
import { shouldCaptureLog } from "./sampling";
import type { SentrinelPluginOptions, RequestLogEntry } from "./types";

type SentrinelState = {
  startTime: number;
  startISO: string;
  requestLogId: string;
  traceId: string;
  spanId: string;
  path: string;
  method: string;
  consumerIdentifier: string | null | undefined;
  url: URL;
};

/**
 * Create the collector + options and start it. Returns the middleware function
 * and a `recordResponse` helper to call after the handler completes.
 *
 * Because `next/server` is a Next.js peer dependency we cannot import it at
 * type-check time.  The middleware returns a plain `Response` that Next.js
 * will treat as `NextResponse.next()` when the body is null/undefined and
 * status is 200.  For the pages-router wrapper we use the raw `res` object.
 */
export function sentrinelNextMiddleware(options: SentrinelPluginOptions) {
  const collector = new MetricsCollector(options);
  const excludePatterns = (options.excludePaths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );

  collector.start();
  if (options.debug) console.log("[sentrinel] Next.js middleware initialized for", options.appName);

  const middleware = async (request: Request): Promise<Response> => {
    const startTime = performance.now();
    const startISO = new Date().toISOString();
    const requestLogId = crypto.randomUUID();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = (request.method || "GET").toUpperCase();

    // Check excluded paths
    if (excludePatterns.some((p) => p.test(path))) {
      // Return an empty 200 — Next.js treats this as "continue".
      return new Response(null, { status: 200 });
    }

    // Trace context
    const incomingHeader =
      request.headers.get("traceparent") ||
      request.headers.get("x-trace-id") ||
      request.headers.get("x-request-id");
    const parsedTrace = parseTraceParent(incomingHeader);
    const traceId = parsedTrace?.traceId || generateTraceId();
    const spanId = parsedTrace?.parentSpanId || generateSpanId();

    // Consumer identifier
    const consumerIdentifier =
      request.headers.get("x-consumer-id") ||
      request.headers.get("x-api-key") ||
      undefined;

    // Build state for post-handler recording.
    // We attach it to the request via a WeakMap-like approach so that
    // recordResponse can look it up later.
    const state: SentrinelState = {
      startTime,
      startISO,
      requestLogId,
      traceId,
      spanId,
      path,
      method,
      consumerIdentifier,
      url,
    };

    // Next.js middleware context is shared via a module-level map keyed by
    // the request object reference — safe because each request is unique.
    pendingRequests.set(request, state);

    // Return an empty 200 response; the caller will produce the real response
    // and then call recordResponse.
    const res = new Response(null, { status: 200 });
    res.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    res.headers.set("x-trace-id", traceId);
    return res;
  };

  /**
   * Call after the handler / route completes to record telemetry.
   */
  const recordResponse = (request: Request, response: Response): void => {
    const state = pendingRequests.get(request);
    if (!state) return;
    pendingRequests.delete(request);

    const { startTime, startISO, requestLogId, traceId, path, method, consumerIdentifier, url } = state;
    const responseTime = Math.round((performance.now() - startTime) * 100) / 100;
    const statusCode = response.status || 200;

    collector.recordRequest({
      path,
      method,
      statusCode,
      responseTime,
      requestSize: parseInt(request.headers.get("content-length") || "0", 10),
      responseSize: parseInt(response.headers.get("content-length") || "0", 10),
      consumerIdentifier,
    });

    if (options.requestLogging?.enabled) {
      const decision = shouldCaptureLog(statusCode, responseTime, options.requestLogging);
      if (!decision.capture) return;

      const entry: RequestLogEntry = {
        id: requestLogId,
        method,
        path,
        statusCode,
        responseTime,
        requestSize: parseInt(request.headers.get("content-length") || "0", 10),
        responseSize: parseInt(response.headers.get("content-length") || "0", 10),
        env: options.env || "dev",
        consumerIdentifier,
        timestamp: startISO,
        sampleRate: decision.sampleRate,
        traceId,
        queryParams: Object.fromEntries(url.searchParams.entries()),
      };

      if (options.requestLogging?.logRequestHeaders) {
        const rawHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => { rawHeaders[key] = value; });
        entry.requestHeaders = options.requestLogging.maskHeaders
          ? maskHeaders(rawHeaders, options.requestLogging.maskHeaders)
          : rawHeaders;
      }

      collector.recordRequestLog(entry);
    }
  };

  return Object.assign(middleware, { recordResponse, stop: () => collector.stop() });
}

// WeakMap to pass state between middleware and recordResponse without
// polluting globalThis or requiring a custom request header.
const pendingRequests = new WeakMap<Request, SentrinelState>();

/**
 * Higher-order wrapper for Pages Router API routes.
 *
 * @example
 * ```ts
 * import { withSentrinel } from "@sentrinel/plugin/next";
 *
 * const handler = (req, res) => { res.json({ ok: true }); };
 * export default withSentrinel({ serverUrl: "...", appName: "..." }, handler);
 * ```
 */
export function withSentrinel(
  options: SentrinelPluginOptions,
  handler: (req: any, res: any) => Promise<any> | any
) {
  const collector = new MetricsCollector(options);
  collector.start();

  if (options.debug) console.log("[sentrinel] Next.js API route handler initialized for", options.appName);

  return async function sentrinelHandler(req: any, res: any) {
    const startTime = performance.now();
    const startISO = new Date().toISOString();
    const requestLogId = crypto.randomUUID();

    const incomingHeader =
      req.headers["traceparent"] ||
      req.headers["x-trace-id"] ||
      req.headers["x-request-id"];
    const parsedTrace = parseTraceParent(incomingHeader);
    const traceId = parsedTrace?.traceId || generateTraceId();

    res.setHeader("traceparent", `00-${traceId}-${generateSpanId()}-01`);
    res.setHeader("x-trace-id", traceId);

    const path = req.url?.split("?")[0] || "/";
    const method = (req.method || "GET").toUpperCase();

    const consumerIdentifier =
      req.headers["x-consumer-id"] ||
      req.headers["x-api-key"] ||
      (typeof options.consumerIdentifier === "string"
        ? req.headers[options.consumerIdentifier.toLowerCase()]
        : undefined);

    try {
      await handler(req, res);
    } finally {
      const responseTime = Math.round((performance.now() - startTime) * 100) / 100;
      const statusCode = res.statusCode || 200;

      collector.recordRequest({
        path,
        method,
        statusCode,
        responseTime,
        requestSize: parseInt(req.headers["content-length"] || "0", 10),
        responseSize: parseInt(res.getHeader("content-length") as string || "0", 10),
        consumerIdentifier,
      });

      if (options.requestLogging?.enabled) {
        const decision = shouldCaptureLog(statusCode, responseTime, options.requestLogging);
        if (decision.capture) {
          collector.recordRequestLog({
            id: requestLogId,
            method,
            path,
            statusCode,
            responseTime,
            requestSize: parseInt(req.headers["content-length"] || "0", 10),
            responseSize: parseInt(res.getHeader("content-length") as string || "0", 10),
            env: options.env || "dev",
            consumerIdentifier,
            timestamp: startISO,
            sampleRate: decision.sampleRate,
            traceId,
          });
        }
      }
    }
  };
}
