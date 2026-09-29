"use strict";
// ─── Sentrinel for Next.js — `@sentrinel/plugin/next` ────────────────────────
//
// Records from inside the route, on the Node runtime:
//
//   // lib/sentrinel.ts
//   import { createSentrinelNext } from "@sentrinel/plugin/next";
//   export const { withSentrinel } = createSentrinelNext({
//     serverUrl: "https://api.sentrinel.dev",
//     appName: "storefront",
//     env: "prod",
//     apiKey: process.env.SENTRINEL_API_KEY,
//   });
//
//   // app/api/orders/[id]/route.ts          (App Router)
//   export const GET = withSentrinel(async (request, { params }) => { … });
//
//   // pages/api/orders/[id].ts               (Pages Router)
//   export default withSentrinel((req, res) => { … });
//
// Why not middleware: Next middleware runs on the Edge runtime *before* the
// route. It cannot see the status or the duration of the response, cannot run
// the collector (`node:os`, `process.cpuUsage`, AsyncLocalStorage are all
// missing there), and a middleware that returns a response without
// `x-middleware-next` replaces the route's response — which is how the previous
// middleware blanked every matched route. A wrapper around the handler sees the
// real response, the real error and the real duration, and runs the handler
// inside the request's trace context so `traceSpan()` and `getLogger()` work.
//
// Route handlers must run on the Node runtime (the default). A handler with
// `export const runtime = "edge"` cannot be wrapped.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPassThrough = exports.sentrinelNextMiddleware = void 0;
exports.routeFromParams = routeFromParams;
exports.createSentrinelNext = createSentrinelNext;
exports.withSentrinel = withSentrinel;
exports.withSentrinelApi = withSentrinelApi;
const body_1 = require("./body");
const core_1 = require("./core");
const express_1 = require("./express");
const node_response_1 = require("./node-response");
var next_middleware_1 = require("./next-middleware");
Object.defineProperty(exports, "sentrinelNextMiddleware", { enumerable: true, get: function () { return next_middleware_1.sentrinelNextMiddleware; } });
Object.defineProperty(exports, "nextPassThrough", { enumerable: true, get: function () { return next_middleware_1.nextPassThrough; } });
/** Captured for error messages when the body is not being logged. */
const ERROR_BODY_BYTES = 8 * 1024;
// ─── One collector per configuration, across hot reloads ─────────────────────
//
// Every route file wraps its own handlers, and `next dev` re-evaluates modules
// on every edit. A collector per wrap — or per reload — would be dozens of
// flush timers each posting its own small batch. Instances are shared by
// configuration and kept on globalThis, which survives module reloads.
const CORES = Symbol.for("sentrinel.next.cores");
function coreFor(options) {
    const g = globalThis;
    const cache = (g[CORES] ?? (g[CORES] = new Map()));
    const key = [options.serverUrl, options.appName, options.env ?? "", options.module ?? "", options.apiKey ?? ""].join("|");
    let core = cache.get(key);
    if (!core) {
        core = (0, core_1.createServerInstrumentation)(options, "Next.js");
        cache.set(key, core);
    }
    return core;
}
// ─── Route pattern ───────────────────────────────────────────────────────────
/**
 * `/api/orders/42` + `{ id: "42" }` → `/api/orders/[id]`.
 *
 * Next hands a route handler its params but not its pattern. Without the
 * pattern every id would be its own endpoint until the collector's id
 * heuristics caught it; with the params it can be rebuilt exactly.
 */
function routeFromParams(pathname, params) {
    if (!params || typeof params !== "object")
        return undefined;
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
    if (!entries.length)
        return undefined;
    const segments = pathname.split("/");
    const decode = (s) => {
        try {
            return decodeURIComponent(s);
        }
        catch {
            return s;
        }
    };
    const matches = (slot, value) => typeof slot === "string" && decode(slot) === String(value);
    // Catch-alls first: they claim a run of segments.
    for (const [name, value] of entries) {
        if (!Array.isArray(value) || !value.length)
            continue;
        for (let i = 1; i + value.length <= segments.length; i++) {
            if (value.every((v, j) => matches(segments[i + j], v))) {
                segments.splice(i, value.length, { placeholder: `[...${name}]` });
                break;
            }
        }
    }
    for (const [name, value] of entries) {
        if (Array.isArray(value))
            continue;
        const idx = segments.findIndex((s, i) => i > 0 && matches(s, value));
        if (idx > 0)
            segments[idx] = { placeholder: `[${name}]` };
    }
    const route = segments.map((s) => (typeof s === "string" ? s : s.placeholder)).join("/");
    return route === pathname ? undefined : route;
}
/**
 * The status a Next navigation error stands for.
 *
 * `redirect()`, `notFound()`, `forbidden()` and `unauthorized()` work by
 * throwing. They are control flow, not failures: recording them as 500s
 * would put every redirect on the Issues page.
 */
function navigationStatus(err) {
    const digest = err?.digest;
    if (typeof digest !== "string")
        return undefined;
    if (digest.startsWith("NEXT_REDIRECT")) {
        const code = Number(digest.split(";")[3]);
        return Number.isFinite(code) && code >= 300 && code < 400 ? code : 307;
    }
    if (digest === "NEXT_NOT_FOUND")
        return 404;
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const code = Number(digest.split(";")[1]);
        return Number.isFinite(code) ? code : 404;
    }
    return undefined;
}
function isPagesCall(args) {
    const res = args[1];
    return !!res && typeof res.setHeader === "function" && typeof res.end === "function";
}
// ─── App Router ──────────────────────────────────────────────────────────────
async function handleAppRoute(core, handler, routeOptions, request, context, rest) {
    const options = core.options;
    let url;
    try {
        url = new URL(request.url);
    }
    catch {
        return handler(request, context, ...rest);
    }
    if (core.isExcludedPath(url.pathname))
        return handler(request, context, ...rest);
    try {
        if (options.excludeRequest?.(request))
            return handler(request, context, ...rest);
    }
    catch {
        // A predicate that throws excludes nothing.
    }
    const header = (name) => request.headers.get(name);
    const state = core.begin(request.method, url, header);
    const logging = options.requestLogging;
    const logResponseBody = !!(logging?.enabled && logging.logResponseBody);
    // Read before the handler starts pulling the stream — see body.ts.
    const requestBody = logging?.enabled && logging.logRequestBody ? await (0, body_1.peekBody)(request, core.maxBodySize) : undefined;
    const resolveRoute = async () => {
        if (routeOptions?.route)
            return routeOptions.route;
        try {
            // Next 15 hands params over as a promise; 13/14 as an object.
            const params = await context?.params;
            return routeFromParams(url.pathname, params);
        }
        catch {
            return undefined;
        }
    };
    const consumerOf = () => {
        if (typeof options.consumerIdentifier === "function") {
            try {
                return options.consumerIdentifier({ request, context });
            }
            catch {
                return null;
            }
        }
        return core.consumerFromHeader(header);
    };
    const requestSize = parseInt(request.headers.get("content-length") || "0", 10) || 0;
    const base = () => ({
        consumer: consumerOf(),
        requestSize,
        requestHeaders: () => {
            const raw = {};
            request.headers.forEach((value, key) => {
                raw[key] = value;
            });
            return raw;
        },
        requestBody: requestBody
            ? {
                text: requestBody.text,
                truncated: requestBody.truncated,
                totalBytes: requestSize || undefined,
                contentType: request.headers.get("content-type"),
            }
            : undefined,
    });
    let response;
    try {
        response = await core.run(state, () => handler(request, context, ...rest));
    }
    catch (err) {
        const nav = navigationStatus(err);
        core.finish(state, {
            ...base(),
            statusCode: nav ?? 500,
            route: await resolveRoute(),
            error: nav ? undefined : (0, core_1.errorShape)(err),
        });
        throw err;
    }
    const route = await resolveRoute();
    const isResponse = typeof Response !== "undefined" && response instanceof Response;
    const statusCode = isResponse ? response.status || 200 : 200;
    const responseSize = isResponse ? parseInt(response.headers.get("content-length") || "0", 10) || 0 : 0;
    if (!isResponse || !(logResponseBody || statusCode >= 400)) {
        core.finish(state, { ...base(), statusCode, route, responseSize });
        return response;
    }
    // Read from a clone after the response is on its way, so the client never
    // waits on telemetry. Streams and binary types are skipped by peekBody.
    const outcome = base();
    void (0, body_1.peekBody)(response, logResponseBody ? core.maxBodySize : ERROR_BODY_BYTES)
        .catch(() => undefined)
        .then((captured) => {
        core.finish(state, {
            ...outcome,
            statusCode,
            route,
            responseSize,
            responseBody: captured
                ? {
                    text: captured.text,
                    truncated: captured.truncated,
                    totalBytes: responseSize || undefined,
                    contentType: response.headers.get("content-type"),
                }
                : undefined,
        });
    });
    return response;
}
async function handlePagesRoute(core, handler, routeOptions, req, res, rest) {
    const options = core.options;
    let url;
    try {
        url = new URL(req.url || "/", "http://localhost");
    }
    catch {
        return handler(req, res, ...rest);
    }
    if (core.isExcludedPath(url.pathname))
        return handler(req, res, ...rest);
    const headerOf = (0, core_1.nodeHeaderGetter)(req.headers);
    const state = core.begin(req.method || "GET", url, headerOf);
    const logResponseBody = !!(options.requestLogging?.enabled && options.requestLogging.logResponseBody);
    const capture = (0, node_response_1.captureNodeResponse)(res, { logBody: logResponseBody, maxBodySize: core.maxBodySize });
    try {
        if (!res.headersSent) {
            res.setHeader("traceparent", `00-${state.trace.traceId}-${state.trace.rootSpanId}-01`);
            res.setHeader("x-trace-id", state.trace.traceId);
        }
    }
    catch { }
    let thrown;
    (0, node_response_1.onResponseDone)(res, (aborted) => {
        try {
            let route = routeOptions?.route;
            if (!route && req.query) {
                // Next merges dynamic params into `req.query`; the ones that are not
                // in the URL's own query string are the path params.
                const params = {};
                for (const [k, v] of Object.entries(req.query))
                    if (!url.searchParams.has(k))
                        params[k] = v;
                route = routeFromParams(url.pathname, params);
            }
            let consumer = null;
            if (typeof options.consumerIdentifier === "function") {
                try {
                    consumer = options.consumerIdentifier({ request: req, req, res });
                }
                catch { }
            }
            else {
                consumer = core.consumerFromHeader(headerOf);
            }
            const nav = thrown !== undefined ? navigationStatus(thrown) : undefined;
            core.finish(state, {
                statusCode: aborted ? 499 : res.statusCode || 200,
                route,
                error: thrown !== undefined && !nav ? (0, core_1.errorShape)(thrown) : undefined,
                consumer,
                requestSize: parseInt(headerOf("content-length") || "0", 10) || 0,
                responseSize: capture.written(),
                requestHeaders: () => (0, core_1.flattenNodeHeaders)(req.headers),
                requestBody: (0, express_1.parsedNodeBody)(req.body, headerOf("content-type"), core.maxBodySize),
                responseBody: capture.body(),
            });
        }
        catch (err) {
            if (options.debug)
                console.error("[sentrinel] Error recording Next.js API request:", err);
        }
    });
    try {
        return await core.run(state, () => handler(req, res, ...rest));
    }
    catch (err) {
        // Next answers a thrown API handler with a 500; the error is kept for the
        // record made when that response finishes.
        thrown = err;
        throw err;
    }
}
function wrap(core, handler, routeOptions) {
    return async function sentrinelHandler(...args) {
        if (isPagesCall(args)) {
            return handlePagesRoute(core, handler.bind(this), routeOptions, args[0], args[1], args.slice(2));
        }
        return handleAppRoute(core, handler.bind(this), routeOptions, args[0], args[1], args.slice(2));
    };
}
/**
 * Build the Next.js integration once, in a module every route imports.
 *
 * `withSentrinel(handler)` wraps an App Router route handler
 * (`export const GET = withSentrinel(async (request, ctx) => …)`) or a Pages
 * Router API route (`export default withSentrinel((req, res) => …)`) — which
 * one is detected from the arguments Next passes.
 */
function createSentrinelNext(options) {
    const core = coreFor(options);
    return {
        withSentrinel: (handler, routeOptions) => wrap(core, handler, routeOptions),
        /** Explicitly a Pages Router API route. `withSentrinel` detects it anyway. */
        withSentrinelApi: (handler, routeOptions) => wrap(core, handler, routeOptions),
        /** Send what is buffered now. */
        flush: () => core.flush(),
        /** Final flush and stop the timer. */
        stop: () => core.stop(),
    };
}
/**
 * One-shot form: `withSentrinel(options, handler)`.
 *
 * Every call with the same `serverUrl`/`appName`/`env`/`module`/`apiKey`
 * shares one collector, so wrapping each route file this way does not start a
 * collector per route. `createSentrinelNext` is the tidier form when many
 * routes are wrapped.
 */
function withSentrinel(options, handler, routeOptions) {
    return wrap(coreFor(options), handler, routeOptions);
}
/** `withSentrinel` for a Pages Router API route, named for readability. */
function withSentrinelApi(options, handler, routeOptions) {
    return wrap(coreFor(options), handler, routeOptions);
}
