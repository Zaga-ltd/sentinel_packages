// ─── Sentrinel Flutter & Mobile Client Utilities ──────────────────────────────
// Helper generators for Flutter / Mobile apps (Dio Interceptor & http Client headers)

import { generateTraceId, generateSpanId } from "./tracer";

export interface FlutterTraceHeaders {
  traceparent: string;
  "x-trace-id": string;
  "x-consumer-id": string;
}

/**
 * Generates W3C traceparent and consumer headers for Flutter Dio Interceptor / http Client.
 */
export function createFlutterHeaderMap(clientName: string = "mobile_flutter"): FlutterTraceHeaders {
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    "x-trace-id": traceId,
    "x-consumer-id": clientName,
  };
}
