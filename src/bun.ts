// ─── Sentrinel Bun Native Adapter ────────────────────────────────────────────
// For Bun.serve() without Elysia. Wraps the fetch handler to record telemetry.
//
// Usage:
//   import { sentrinelBunMiddleware } from "@sentrinel/plugin/bun";
//
//   Bun.serve({
//     port: 3000,
//     fetch: sentrinelBunMiddleware(options, async (req) => {
//       return new Response("Hello");
//     }),
//   });

import { MetricsCollector } from "./collector";
import { parseTraceParent, generateTraceId, generateSpanId } from "./tracer";
import { maskHeaders, maskBodyFields, maskQueryParams, truncateBody } from "./masking";
import { shouldCaptureLog } from "./sampling";
import type { SentrinelPluginOptions, RequestLogEntry } from "./types";

type FetchHandler = (req: Request, server: any) => Response | Promise<Response>;

export function sentrinelBunMiddleware(
  options: SentrinelPluginOptions,
  handler: FetchHandler
): FetchHandler {
  const collector = new MetricsCollector(options);
  const excludePatterns = (options.excludePaths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65_536;

  collector.start();
  if (options.debug) console.log("[sentrinel] Bun middleware initialized for", options.appName);

  return async function instrumentedFetch(req: Request, server: any): Promise<Response> {
    const startTime = performance.now();
    const startISO = new Date().toISOString();
    const requestLogId = crypto.randomUUID();

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Check excluded paths
    if (excludePatterns.some((p) => p.test(path))) {
      return handler(req, server);
    }

    // Trace context
    const incomingHeader =
      req.headers.get("traceparent") ||
      req.headers.get("x-trace-id") ||
      req.headers.get("x-request-id");
    const parsedTrace = parseTraceParent(incomingHeader);
    const traceId = parsedTrace?.traceId || generateTraceId();
    const spanId = parsedTrace?.parentSpanId || generateSpanId();

    // Consumer identifier
    let consumerIdentifier: string | null | undefined = null;
    if (typeof options.consumerIdentifier === "function") {
      try { consumerIdentifier = options.consumerIdentifier({ request: req } as any); } catch {}
    } else if (typeof options.consumerIdentifier === "string") {
      consumerIdentifier = req.headers.get(options.consumerIdentifier.toLowerCase());
    }

    // Capture error
    let response: Response;
    let capturedError: { name: string; message: string; stack?: string } | undefined;

    try {
      response = await handler(req, server);
    } catch (err) {
      if (err instanceof Error) {
        capturedError = { name: err.name, message: err.message, stack: err.stack };
      }
      // Re-throw after recording
      const responseTime = Math.round((performance.now() - startTime) * 100) / 100;

      collector.recordRequest({
        path,
        method,
        statusCode: 500,
        responseTime,
        requestSize: parseInt(req.headers.get("content-length") || "0", 10),
        responseSize: 0,
        consumerIdentifier,
      });

      collector.recordError({
        method,
        path,
        statusCode: 500,
        statusMessage: "Internal Server Error",
        errorType: capturedError?.name,
        errorMessage: capturedError?.message,
        stackTrace: capturedError?.stack,
        consumerIdentifier,
        timestamp: startISO,
        requestLogId,
        traceId,
      });

      throw err;
    }

    const responseTime = Math.round((performance.now() - startTime) * 100) / 100;
    const statusCode = response.status || 200;

    // Record metrics
    collector.recordRequest({
      path,
      method,
      statusCode,
      responseTime,
      requestSize: parseInt(req.headers.get("content-length") || "0", 10),
      responseSize: parseInt(response.headers.get("content-length") || "0", 10),
      consumerIdentifier,
    });

    // Record errors
    if (statusCode >= 400 || capturedError) {
      let errorMessage = capturedError?.message;
      let errorType = capturedError?.name;
      let stackTrace = capturedError?.stack;

      if (!errorMessage) {
        try {
          const body = await response.clone().text();
          const parsed = JSON.parse(body);
          errorMessage = parsed.message || parsed.error;
          errorType = parsed.name || parsed.type;
        } catch {}
      }

      collector.recordError({
        method,
        path,
        statusCode,
        statusMessage: getStatusMessage(statusCode),
        errorType,
        errorMessage,
        stackTrace,
        consumerIdentifier,
        timestamp: startISO,
        requestLogId,
        traceId,
      });
    }

    // Record request log
    if (options.requestLogging?.enabled) {
      const decision = shouldCaptureLog(statusCode, responseTime, options.requestLogging);
      if (decision.capture) {
        const entry: RequestLogEntry = {
          id: requestLogId,
          method,
          path,
          statusCode,
          responseTime,
          requestSize: parseInt(req.headers.get("content-length") || "0", 10),
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
          req.headers.forEach((value, key) => { rawHeaders[key] = value; });
          entry.requestHeaders = options.requestLogging.maskHeaders
            ? maskHeaders(rawHeaders, options.requestLogging.maskHeaders)
            : rawHeaders;
        }

        collector.recordRequestLog(entry);
      }
    }

    return response;
  };
}

function getStatusMessage(code: number): string {
  const messages: Record<number, string> = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
    409: "Conflict", 410: "Gone", 413: "Payload Too Large",
    415: "Unsupported Media Type", 422: "Unprocessable Content",
    429: "Too Many Requests", 500: "Internal Server Error",
    501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return messages[code] || `HTTP ${code}`;
}
