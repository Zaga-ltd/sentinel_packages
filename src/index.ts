import { Elysia } from "elysia";
import { MetricsCollector } from "./collector";
import { maskQueryParams, maskHeaders, maskBodyFields, truncateBody } from "./masking";
import type { SentinelPluginOptions, RequestLogEntry } from "./types";
import { shouldCaptureLog } from "./sampling";
import { instrumentConsole, beginRequestLogContext, drainRequestLogs } from "./logs";

export type { SentinelPluginOptions, RequestLoggingOptions } from "./types";

/**
 * Sentinel Elysia Plugin
 *
 * Instruments your Elysia application with API monitoring, metrics collection,
 * request logging, and error tracking. Data is sent to a Sentinel API server
 * for visualization in the Sentinel dashboard.
 *
 * @example
 * ```ts
 * import { sentinelPlugin } from '@sentinel/plugin';
 *
 * const app = new Elysia()
 *   .use(sentinelPlugin({
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
export function sentinelPlugin(options: SentinelPluginOptions) {
  const collector = new MetricsCollector(options);
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65_536; // 64KB default
  const excludePatterns = (options.excludePaths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );

  return (app: any) => {
    collector.start();
    if (options.logCapture?.enabled) instrumentConsole(options.logCapture);
    if (options.debug) console.log("[sentinel] Plugin initialized for", options.appName);

    app.onStop(async () => {
      await collector.stop();
    });

    app.derive(({ request }: any) => {
      const requestLogId = crypto.randomUUID();
      if (options.logCapture?.enabled) beginRequestLogContext(requestLogId);
      return {
        _sentinelStartTime: performance.now(),
        _sentinelRequestUrl: new URL(request.url),
        _sentinelRequestLogId: requestLogId,
      };
    });

    app.onAfterResponse(async (ctx: any) => {
      try {
        const startTime = (ctx as any)._sentinelStartTime as number;
        const requestUrl = (ctx as any)._sentinelRequestUrl as URL;
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
        if (options.consumerIdentifier) {
          try {
            consumerIdentifier = options.consumerIdentifier(ctx);
          } catch {}
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

        // Record errors
        if (statusCode >= 400) {
          let errorMessage: string | undefined;
          let errorType: string | undefined;
          let stackTrace: string | undefined;

          if (ctx.response && typeof ctx.response === "object") {
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
          });
        }

        // Record request log (if enabled), applying head sampling.
        //
        // Metrics above are already recorded, so counters stay exact no
        // matter the sample rate. Errors and slow requests always pass.
        // Drain app logs captured while handling this request.
        const requestLogId = (ctx as any)._sentinelRequestLogId as string;
        const drained = options.logCapture?.enabled
          ? drainRequestLogs()
          : { logs: [], dropped: 0 };
        const hasErrorLogs = drained.logs.some((l) => l.level === "error");
        if (drained.logs.length) collector.recordAppLogs(drained.logs);

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
            path: pathname,
            statusCode,
            responseTime: Math.round(responseTime * 100) / 100,
            requestSize,
            responseSize,
            env: options.env || "dev",
            consumerIdentifier,
            timestamp: new Date().toISOString(),
            sampleRate: hasErrorLogs ? 1 : decision.sampleRate,
          };

          // Log headers (masked)
          if (options.requestLogging.logRequestHeaders) {
            const rawHeaders: Record<string, string> = {};
            ctx.request.headers.forEach((value, key) => {
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

          // Log request body (masked + truncated)
          if (options.requestLogging.logRequestBody) {
            try {
              const clonedReq = ctx.request.clone();
              const bodyText = await clonedReq.text();
              if (bodyText) {
                let maskedBody = options.requestLogging.maskBodyFields
                  ? maskBodyFields(bodyText, options.requestLogging.maskBodyFields)
                  : bodyText;
                if (typeof maskedBody === "object") maskedBody = JSON.stringify(maskedBody);
                entry.requestBody = truncateBody(maskedBody, maxBodySize);
              }
            } catch {}
          }

          // Log response body (masked + truncated)
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
        if (options.debug) console.error("[sentinel] Error in afterResponse hook:", err);
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
