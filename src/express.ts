// ─── Sentrinel Express.js Middleware ───────────────────────────────────────────
// Express middleware for telemetry ingestion, request logging, error tracking,
// distributed tracing, and structured logging.

import { MetricsCollector } from "./collector";
import { parseTraceParent, generateTraceId, generateSpanId } from "./tracer";
import { maskHeaders, maskBodyFields, maskQueryParams, truncateBody } from "./masking";
import { shouldCaptureLog } from "./sampling";
import { instrumentConsole, beginRequestLogContext, drainRequestLogs } from "./logs";
import {
  setLogSink,
  setCorrelationSource,
  enterRequestScope,
  currentRequestId,
  beginCanonicalScope,
  drainCanonicalFields,
  type LogRecord,
} from "./logger";
import type { SentrinelPluginOptions, RequestLogEntry } from "./types";
import { resolveConsumer } from "./types";

// Structural types — no `import type from "express"` needed.
interface Request {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  originalUrl?: string;
  route?: { path?: string };
  query?: unknown;
  body?: unknown;
  method_upper?: string;
}
interface Response {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  getHeader(name: string): unknown;
  end: (...args: any[]) => any;
  write: (...args: any[]) => any;
}
type NextFunction = (err?: unknown) => void;

export function sentrinelExpressMiddleware(options: SentrinelPluginOptions) {
  const collector = new MetricsCollector(options);
  const excludePatterns = (options.excludePaths || []).map((p) =>
    typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p
  );
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65_536;

  collector.start();

  if (options.logCapture?.enabled) instrumentConsole(options.logCapture);

  // Structured logging setup
  if (options.logging?.echo) {
    const { setLogEcho } = require("./logger");
    setLogEcho(true);
  }
  if (options.logging?.minLevel) {
    const { setLogLevel } = require("./logger");
    setLogLevel(options.logging.minLevel);
  }
  setCorrelationSource(() => ({
    requestId: currentRequestId(),
    traceId: undefined,
    spanId: undefined,
  }));

  const ownSink = (record: LogRecord) => {
    collector.recordAppLogs([{
      timestamp: record.timestamp,
      level: record.level,
      message: record.message,
      category: record.category,
      attributes: record.attributes,
      requestId: record.requestId,
      traceId: record.traceId,
      spanId: record.spanId,
    }]);
  };
  setLogSink(ownSink);

  if (options.debug) console.log("[sentrinel] Express middleware initialized for", options.appName);

  return function middleware(req: Request, res: Response, next: NextFunction) {
    const startTime = performance.now();
    const startISO = new Date().toISOString();
    const requestLogId = crypto.randomUUID();

    // Trace context
    const incomingHeader =
      (req.headers["traceparent"] as string) ||
      (req.headers["x-trace-id"] as string) ||
      (req.headers["x-request-id"] as string);
    const parsedTrace = parseTraceParent(incomingHeader);
    const traceId = parsedTrace?.traceId || generateTraceId();
    const spanId = parsedTrace?.parentSpanId || generateSpanId();

    // Set up request context for structured logging
    if (options.logCapture?.enabled) beginRequestLogContext(requestLogId);
    enterRequestScope(requestLogId, ownSink);
    beginCanonicalScope();

    // Set trace headers on response
    res.setHeader("traceparent", `00-${traceId}-${spanId}-01`);
    res.setHeader("x-trace-id", traceId);

    const path = req.route?.path || req.path || req.originalUrl || "/";
    const method = req.method ? req.method.toUpperCase() : "GET";

    // Check if path is excluded
    if (excludePatterns.some((p) => p.test(path))) return next();

    const originalEnd = res.end;
    let capturedError: { name: string; message: string; stack?: string } | undefined;

    // Capture thrown errors
    const originalNext = next;
    (next as any) = function capturedNext(err?: unknown) {
      if (err instanceof Error) {
        capturedError = { name: err.name, message: err.message, stack: err.stack };
      }
      originalNext(err);
    };

    // Monkey-patch res.end to capture response
    res.end = function (chunk?: any, encoding?: any, cb?: any): any {
      const responseTime = Math.round((performance.now() - startTime) * 100) / 100;
      const statusCode = res.statusCode || 200;

      // Check exclusion again (status-based)
      if (excludePatterns.some((p) => p.test(path))) {
        return originalEnd.call(this, chunk, encoding, cb);
      }

      // Consumer identifier
      let consumerIdentifier: string | null | undefined = null;
      let consumerName: string | undefined;
      let consumerGroup: string | undefined;
      if (typeof options.consumerIdentifier === "function") {
        try {
          const r = resolveConsumer(options.consumerIdentifier({ request: req } as any));
          consumerIdentifier = r.identifier;
          consumerName = r.name;
          consumerGroup = r.group;
        } catch {}
      } else if (typeof options.consumerIdentifier === "string") {
        consumerIdentifier = req.headers[options.consumerIdentifier.toLowerCase()] as string;
      }

      // Sizes
      const requestSize = parseInt(req.headers["content-length"] as string || "0", 10);
      let responseSize = 0;
      if (chunk) {
        try {
          responseSize = typeof chunk === "string"
            ? new TextEncoder().encode(chunk).byteLength
            : Buffer.byteLength(chunk);
        } catch {}
      }

      // Record metrics
      collector.recordRequest({
        path,
        method,
        statusCode,
        responseTime,
        requestSize,
        responseSize,
        consumerIdentifier,
        consumerName,
        consumerGroup,
      });

      // Record errors
      if (statusCode >= 400 || capturedError) {
        let errorMessage = capturedError?.message;
        let errorType = capturedError?.name;
        let stackTrace = capturedError?.stack;

        if (!errorMessage && typeof chunk === "string") {
          try {
            const body = JSON.parse(chunk);
            errorMessage = body.message || body.error;
            errorType = body.name || body.type;
          } catch {
            errorMessage = chunk.substring(0, 500);
          }
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
      const drained = options.logCapture?.enabled ? drainRequestLogs() : { logs: [], dropped: 0 };
      const hasErrorLogs = drained.logs.some((l) => l.level === "error");
      if (drained.logs.length) collector.recordAppLogs(drained.logs);

      const canonicalFields = drainCanonicalFields();

      if (options.requestLogging?.enabled) {
        const decision = shouldCaptureLog(statusCode, responseTime, options.requestLogging);
        if (!decision.capture && !hasErrorLogs) {
          return originalEnd.call(this, chunk, encoding, cb);
        }

        const entry: RequestLogEntry = {
          id: requestLogId,
          method,
          path,
          statusCode,
          responseTime,
          requestSize,
          responseSize,
          env: options.env || "dev",
          consumerIdentifier,
          timestamp: startISO,
          sampleRate: hasErrorLogs ? 1 : decision.sampleRate,
          traceId,
          attributes: canonicalFields,
        };

        // Headers
        if (options.requestLogging?.logRequestHeaders) {
          entry.requestHeaders = options.requestLogging.maskHeaders
            ? maskHeaders(req.headers as Record<string, string>, options.requestLogging.maskHeaders)
            : req.headers as Record<string, string>;
        }

        // Query params
        if (req.query && Object.keys(req.query).length > 0) {
          entry.queryParams = options.requestLogging.maskQueryParams
            ? maskQueryParams(req.query as Record<string, string>, options.requestLogging.maskQueryParams)
            : req.query as Record<string, string>;
        }

        // Request body
        if (options.requestLogging?.logRequestBody && req.body) {
          try {
            const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
            if (raw && raw !== "{}") {
              entry.requestBody = truncateBody(
                options.requestLogging.maskBodyFields
                  ? maskBodyFields(raw, options.requestLogging.maskBodyFields)
                  : raw,
                maxBodySize
              );
            }
          } catch {}
        }

        // Response body
        if (options.requestLogging?.logResponseBody && chunk) {
          try {
            const bodyText = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
            entry.responseBody = truncateBody(
              options.requestLogging.maskBodyFields
                ? maskBodyFields(bodyText, options.requestLogging.maskBodyFields)
                : bodyText,
              maxBodySize
            );
          } catch {}
        }

        collector.recordRequestLog(entry);
      }

      return originalEnd.call(this, chunk, encoding, cb);
    };

    next();
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
