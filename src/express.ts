// ─── Sentrinel Express.js Middleware ───────────────────────────────────────────
// Express middleware for telemetry ingestion, request logging, error tracking, and W3C trace propagation

// Structural types rather than `import type … from "express"`.
//
// Express is an optional integration: an Elysia-only user should not have to
// install it, and the published package must type-check on its own. These
// describe exactly the surface this middleware touches.
interface Request {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  originalUrl?: string;
  route?: { path?: string };
  query?: unknown;
  body?: unknown;
}
interface Response {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  getHeader(name: string): unknown;
  end: (...args: any[]) => any;
}
type NextFunction = (err?: unknown) => void;
import { MetricsCollector } from "./collector";
import { parseTraceParent, generateTraceId, generateSpanId } from "./tracer";
import { maskHeaders, maskBodyFields, truncateBody } from "./masking";
import type { SentrinelPluginOptions } from "./types";

export function sentrinelExpressMiddleware(options: SentrinelPluginOptions) {
  const collector = new MetricsCollector(options);

  return function middleware(req: Request, res: Response, next: NextFunction) {
    const startTime = performance.now();
    const startISO = new Date().toISOString();

    const incomingHeader =
      (req.headers["traceparent"] as string) ||
      (req.headers["x-trace-id"] as string) ||
      (req.headers["x-request-id"] as string);
    const parsedTrace = parseTraceParent(incomingHeader);

    const traceId = parsedTrace?.traceId || generateTraceId();
    const spanId = generateSpanId();

    // Attach W3C trace headers to outgoing response
    res.setHeader("traceparent", `00-${traceId}-${spanId}-01`);
    res.setHeader("x-trace-id", traceId);

    const originalEnd = res.end;
    let responseBody: string | undefined;

    // Capture response end
    res.end = function (chunk?: any, encoding?: any, cb?: any): any {
      const responseTime = Math.round((performance.now() - startTime) * 100) / 100;

      // Extract consumer
      const consumerIdentifier = options.consumerIdentifier
        ? typeof options.consumerIdentifier === "function"
          ? options.consumerIdentifier({ request: req } as any)
          : req.headers[options.consumerIdentifier.toLowerCase()] as string
        : (req.headers["x-consumer-id"] as string) || (req.headers["x-api-key"] as string);

      const path = req.route?.path || req.path || req.originalUrl || "/";
      const method = req.method ? req.method.toUpperCase() : "GET";
      const statusCode = res.statusCode || 200;

      // Record metrics
      collector.recordRequest({
        path,
        method,
        statusCode,
        responseTime,
        requestSize: parseInt(req.headers["content-length"] as string || "0", 10),
        responseSize: parseInt(res.getHeader("content-length") as string || "0", 10),
        consumerIdentifier,
      });

      // Record log entry if enabled
      if (options.requestLogging?.enabled !== false) {
        let reqHeaders: Record<string, string> | undefined;
        if (options.requestLogging?.logRequestHeaders) {
          reqHeaders = maskHeaders(
            req.headers as Record<string, string>,
            options.requestLogging.maskHeaders
          );
        }

        let reqBody: string | undefined;
        if (options.requestLogging?.logRequestBody && req.body) {
          const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
          const masked = maskBodyFields(bodyStr, options.requestLogging.maskBodyFields);
          reqBody = truncateBody(masked, options.requestLogging.maxBodySize);
        }

        collector.recordRequestLog({
          method,
          path,
          statusCode,
          responseTime,
          requestSize: parseInt(req.headers["content-length"] as string || "0", 10),
          responseSize: parseInt(res.getHeader("content-length") as string || "0", 10),
          consumerIdentifier,
          requestHeaders: reqHeaders,
          requestBody: reqBody,
          responseBody,
          queryParams: req.query as Record<string, string>,
          traceId,
          timestamp: startISO,
        });
      }

      return originalEnd.call(this, chunk, encoding, cb);
    };

    next();
  };
}
