import {
  generateSpanId,
  generateTraceId
} from "./index-gaj32fp1.js";

// src/flutter.ts
function createFlutterHeaderMap(clientName = "mobile_flutter") {
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    "x-trace-id": traceId,
    "x-consumer-id": clientName
  };
}

export { createFlutterHeaderMap };
