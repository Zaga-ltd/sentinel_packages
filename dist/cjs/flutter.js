"use strict";
// ─── Sentrinel Flutter & Mobile Client Utilities ──────────────────────────────
// Helper generators for Flutter / Mobile apps (Dio Interceptor & http Client headers)
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFlutterHeaderMap = createFlutterHeaderMap;
const tracer_1 = require("./tracer");
/**
 * Generates W3C traceparent and consumer headers for Flutter Dio Interceptor / http Client.
 */
function createFlutterHeaderMap(clientName = "mobile_flutter") {
    const traceId = (0, tracer_1.generateTraceId)();
    const spanId = (0, tracer_1.generateSpanId)();
    return {
        traceparent: `00-${traceId}-${spanId}-01`,
        "x-trace-id": traceId,
        "x-consumer-id": clientName,
    };
}
