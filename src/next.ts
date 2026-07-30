// ─── Sentrinel Next.js Middleware ─────────────────────────────────────────────
// Next.js App Router / API route telemetry middleware and client context propagator

import { MetricsCollector } from "./collector";
import { parseTraceParent, generateTraceId, generateSpanId } from "./tracer";
import type { SentrinelPluginOptions } from "./types";

export function sentrinelNextMiddleware(options: SentrinelPluginOptions) {
  const collector = new MetricsCollector(options);

  return async function middleware(request: Request) {
    const startTime = performance.now();
    const startISO = new Date().toISOString();

    const incomingHeader =
      request.headers.get("traceparent") ||
      request.headers.get("x-trace-id") ||
      request.headers.get("x-request-id");
    const parsedTrace = parseTraceParent(incomingHeader);

    const traceId = parsedTrace?.traceId || generateTraceId();
    const spanId = generateSpanId();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method ? request.method.toUpperCase() : "GET";

    const consumerIdentifier =
      request.headers.get("x-consumer-id") ||
      request.headers.get("x-api-key") ||
      undefined;

    return {
      traceId,
      spanId,
      headers: {
        traceparent: `00-${traceId}-${spanId}-01`,
        "x-trace-id": traceId,
      },
      recordResponse: (response: Response) => {
        const responseTime = Math.round((performance.now() - startTime) * 100) / 100;
        collector.recordRequest({
          path,
          method,
          statusCode: response.status,
          responseTime,
          requestSize: parseInt(request.headers.get("content-length") || "0", 10),
          responseSize: parseInt(response.headers.get("content-length") || "0", 10),
          consumerIdentifier,
        });

        collector.recordRequestLog({
          method,
          path,
          statusCode: response.status,
          responseTime,
          requestSize: parseInt(request.headers.get("content-length") || "0", 10),
          responseSize: parseInt(response.headers.get("content-length") || "0", 10),
          consumerIdentifier,
          queryParams: Object.fromEntries(url.searchParams.entries()),
          traceId,
          timestamp: startISO,
        });
      },
    };
  };
}
