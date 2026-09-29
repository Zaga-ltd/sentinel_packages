"use strict";
// ─── Sentrinel Bun Native Adapter — `@sentrinel/plugin/bun` ──────────────────
// For Bun.serve() without Elysia. Wraps the fetch handler to record telemetry.
//
// Usage:
//   import { sentrinelBunMiddleware } from "@sentrinel/plugin/bun";
//
//   Bun.serve({
//     port: 3000,
//     fetch: sentrinelBunMiddleware(options, async (req) => {
//       return new Response("Hello");
//     }),
//   });
//
// The handler runs inside the request's trace context, so `traceSpan()` and
// `getLogger()` attach to this request. Bodies are read only as far as
// `maxBodySize`, and a response body is read after the response has been
// handed back — never in the way of it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sentrinelBunMiddleware = sentrinelBunMiddleware;
const body_1 = require("./body");
const core_1 = require("./core");
/** Captured for error messages when the body is not being logged. */
const ERROR_BODY_BYTES = 8 * 1024;
function sentrinelBunMiddleware(options, handler) {
    const core = (0, core_1.createServerInstrumentation)(options, "Bun middleware");
    const logging = options.requestLogging;
    const logRequestBody = !!(logging?.enabled && logging.logRequestBody);
    const logResponseBody = !!(logging?.enabled && logging.logResponseBody);
    const instrumentedFetch = async function instrumentedFetch(req, server) {
        let url;
        try {
            url = new URL(req.url);
        }
        catch {
            return handler(req, server);
        }
        if (core.isExcludedPath(url.pathname))
            return handler(req, server);
        try {
            if (options.excludeRequest?.(req))
                return handler(req, server);
        }
        catch {
            // A predicate that throws excludes nothing.
        }
        const header = (name) => req.headers.get(name);
        const state = core.begin(req.method, url, header);
        // Read before the handler starts pulling the stream — see body.ts.
        const requestBody = logRequestBody
            ? await (0, body_1.peekBody)(req, core.maxBodySize)
            : undefined;
        let consumer = null;
        if (typeof options.consumerIdentifier === "function") {
            try {
                consumer = options.consumerIdentifier({ request: req });
            }
            catch { }
        }
        else {
            consumer = core.consumerFromHeader(header);
        }
        const requestSize = parseInt(req.headers.get("content-length") || "0", 10) || 0;
        const base = {
            consumer,
            requestSize,
            requestHeaders: () => {
                const raw = {};
                req.headers.forEach((value, key) => {
                    raw[key] = value;
                });
                return raw;
            },
            requestBody: requestBody
                ? {
                    text: requestBody.text,
                    truncated: requestBody.truncated,
                    totalBytes: requestSize || undefined,
                    contentType: req.headers.get("content-type"),
                }
                : undefined,
        };
        let response;
        try {
            response = await core.run(state, () => handler(req, server));
        }
        catch (err) {
            core.finish(state, { ...base, statusCode: 500, error: (0, core_1.errorShape)(err) });
            throw err;
        }
        const statusCode = response?.status || 200;
        const responseSize = parseInt(response?.headers?.get("content-length") || "0", 10) || 0;
        const wantBody = logResponseBody || statusCode >= 400;
        if (!wantBody || !response) {
            core.finish(state, { ...base, statusCode, responseSize });
            return response;
        }
        // The body is read from a clone after the response is on its way, so the
        // client never waits on telemetry. Streams and binary types are skipped
        // outright by peekBody.
        void (0, body_1.peekBody)(response, logResponseBody ? core.maxBodySize : ERROR_BODY_BYTES)
            .catch(() => undefined)
            .then((captured) => {
            core.finish(state, {
                ...base,
                statusCode,
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
    };
    return Object.assign(instrumentedFetch, {
        flush: () => core.flush(),
        stop: () => core.stop(),
    });
}
