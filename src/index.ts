// ─── @sentrinel/plugin ───────────────────────────────────────────────────────
//
// The root entry: the Elysia plugin (where it has always been imported from),
// tracing, logging and custom metrics, and the other server adapters for
// convenience.
//
// It imports no framework. The Elysia plugin is a plain `(app) => app`
// function, so an Express or Next app that never installed `elysia` can import
// from here — it used to fail at load, because this file imported `elysia` for
// a type it never used. Each adapter also has its own entry
// (`@sentrinel/plugin/elysia`, `/express`, `/next`, `/bun`), which is the
// better import: it loads only that adapter.
//
// Node-side only. A web page imports `@sentrinel/plugin/browser`, which pulls
// in nothing from here.

export { sentrinelPlugin } from "./elysia";
export type {
  SentrinelPluginOptions,
  RequestLoggingOptions,
  ConsumerIdentity,
} from "./types";
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
  type SpanHandle,
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
export { sentrinelExpressMiddleware, sentrinelErrorHandler } from "./express";
export { sentrinelNextMiddleware, createSentrinelNext, withSentrinel, withSentrinelApi } from "./next";
export { sentrinelBunMiddleware } from "./bun";
export { createFlutterHeaderMap } from "./flutter";
export { maskUrl, maskHeaders, maskQueryParams, maskBodyFields } from "./masking";
export { flushAll as flushSentrinel } from "./process-hooks";
export {
  count,
  gauge,
  histogram,
  metric,
  metricRegistry,
  MetricRegistry,
  type MetricKind,
  type MetricLabels,
  type MetricPoint,
} from "./metrics";
