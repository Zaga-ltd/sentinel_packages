"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricRegistry = exports.metricRegistry = exports.metric = exports.histogram = exports.gauge = exports.count = exports.flushSentrinel = exports.maskBodyFields = exports.maskQueryParams = exports.maskHeaders = exports.maskUrl = exports.createFlutterHeaderMap = exports.sentrinelBunMiddleware = exports.withSentrinelApi = exports.withSentrinel = exports.createSentrinelNext = exports.sentrinelNextMiddleware = exports.sentrinelErrorHandler = exports.sentrinelExpressMiddleware = exports.setLogLevel = exports.setLogEcho = exports.addRequestContext = exports.clearRequestScope = exports.currentContext = exports.addContext = exports.withContext = exports.logger = exports.getLogger = exports.createClientTracer = exports.createTraceParentHeader = exports.parseTraceParent = exports.generateUuidV7 = exports.generateSpanId = exports.generateTraceId = exports.sentrinelFetch = exports.traceObject = exports.traced = exports.tspan = exports.traceSpan = exports.sentrinelPlugin = void 0;
var elysia_1 = require("./elysia");
Object.defineProperty(exports, "sentrinelPlugin", { enumerable: true, get: function () { return elysia_1.sentrinelPlugin; } });
var tracer_1 = require("./tracer");
Object.defineProperty(exports, "traceSpan", { enumerable: true, get: function () { return tracer_1.traceSpan; } });
Object.defineProperty(exports, "tspan", { enumerable: true, get: function () { return tracer_1.tspan; } });
Object.defineProperty(exports, "traced", { enumerable: true, get: function () { return tracer_1.traced; } });
Object.defineProperty(exports, "traceObject", { enumerable: true, get: function () { return tracer_1.traceObject; } });
Object.defineProperty(exports, "sentrinelFetch", { enumerable: true, get: function () { return tracer_1.sentrinelFetch; } });
Object.defineProperty(exports, "generateTraceId", { enumerable: true, get: function () { return tracer_1.generateTraceId; } });
Object.defineProperty(exports, "generateSpanId", { enumerable: true, get: function () { return tracer_1.generateSpanId; } });
Object.defineProperty(exports, "generateUuidV7", { enumerable: true, get: function () { return tracer_1.generateUuidV7; } });
Object.defineProperty(exports, "parseTraceParent", { enumerable: true, get: function () { return tracer_1.parseTraceParent; } });
Object.defineProperty(exports, "createTraceParentHeader", { enumerable: true, get: function () { return tracer_1.createTraceParentHeader; } });
Object.defineProperty(exports, "createClientTracer", { enumerable: true, get: function () { return tracer_1.createClientTracer; } });
var logger_1 = require("./logger");
Object.defineProperty(exports, "getLogger", { enumerable: true, get: function () { return logger_1.getLogger; } });
Object.defineProperty(exports, "logger", { enumerable: true, get: function () { return logger_1.logger; } });
Object.defineProperty(exports, "withContext", { enumerable: true, get: function () { return logger_1.withContext; } });
Object.defineProperty(exports, "addContext", { enumerable: true, get: function () { return logger_1.addContext; } });
Object.defineProperty(exports, "currentContext", { enumerable: true, get: function () { return logger_1.currentContext; } });
Object.defineProperty(exports, "clearRequestScope", { enumerable: true, get: function () { return logger_1.clearRequestScope; } });
Object.defineProperty(exports, "addRequestContext", { enumerable: true, get: function () { return logger_1.addRequestContext; } });
Object.defineProperty(exports, "setLogEcho", { enumerable: true, get: function () { return logger_1.setLogEcho; } });
Object.defineProperty(exports, "setLogLevel", { enumerable: true, get: function () { return logger_1.setLogLevel; } });
var express_1 = require("./express");
Object.defineProperty(exports, "sentrinelExpressMiddleware", { enumerable: true, get: function () { return express_1.sentrinelExpressMiddleware; } });
Object.defineProperty(exports, "sentrinelErrorHandler", { enumerable: true, get: function () { return express_1.sentrinelErrorHandler; } });
var next_1 = require("./next");
Object.defineProperty(exports, "sentrinelNextMiddleware", { enumerable: true, get: function () { return next_1.sentrinelNextMiddleware; } });
Object.defineProperty(exports, "createSentrinelNext", { enumerable: true, get: function () { return next_1.createSentrinelNext; } });
Object.defineProperty(exports, "withSentrinel", { enumerable: true, get: function () { return next_1.withSentrinel; } });
Object.defineProperty(exports, "withSentrinelApi", { enumerable: true, get: function () { return next_1.withSentrinelApi; } });
var bun_1 = require("./bun");
Object.defineProperty(exports, "sentrinelBunMiddleware", { enumerable: true, get: function () { return bun_1.sentrinelBunMiddleware; } });
var flutter_1 = require("./flutter");
Object.defineProperty(exports, "createFlutterHeaderMap", { enumerable: true, get: function () { return flutter_1.createFlutterHeaderMap; } });
var masking_1 = require("./masking");
Object.defineProperty(exports, "maskUrl", { enumerable: true, get: function () { return masking_1.maskUrl; } });
Object.defineProperty(exports, "maskHeaders", { enumerable: true, get: function () { return masking_1.maskHeaders; } });
Object.defineProperty(exports, "maskQueryParams", { enumerable: true, get: function () { return masking_1.maskQueryParams; } });
Object.defineProperty(exports, "maskBodyFields", { enumerable: true, get: function () { return masking_1.maskBodyFields; } });
var process_hooks_1 = require("./process-hooks");
Object.defineProperty(exports, "flushSentrinel", { enumerable: true, get: function () { return process_hooks_1.flushAll; } });
var metrics_1 = require("./metrics");
Object.defineProperty(exports, "count", { enumerable: true, get: function () { return metrics_1.count; } });
Object.defineProperty(exports, "gauge", { enumerable: true, get: function () { return metrics_1.gauge; } });
Object.defineProperty(exports, "histogram", { enumerable: true, get: function () { return metrics_1.histogram; } });
Object.defineProperty(exports, "metric", { enumerable: true, get: function () { return metrics_1.metric; } });
Object.defineProperty(exports, "metricRegistry", { enumerable: true, get: function () { return metrics_1.metricRegistry; } });
Object.defineProperty(exports, "MetricRegistry", { enumerable: true, get: function () { return metrics_1.MetricRegistry; } });
