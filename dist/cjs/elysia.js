"use strict";
// ─── Sentrinel Elysia plugin — `@sentrinel/plugin/elysia` ────────────────────
//
// Also exported from the package root, where it has always been. It imports
// nothing from `elysia`: a plugin is just `(app) => app`, so the root entry
// works for an Express or Next app that never installed Elysia.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sentrinelPlugin = sentrinelPlugin;
const body_1 = require("./body");
const core_1 = require("./core");
/**
 * Sentrinel Elysia Plugin
 *
 * Instruments your Elysia application with API monitoring, metrics collection,
 * request logging, and error tracking. Data is sent to a Sentrinel API server
 * for visualization in the Sentrinel dashboard.
 *
 * @example
 * ```ts
 * import { sentrinelPlugin } from '@sentrinel/plugin';
 *
 * const app = new Elysia()
 *   .use(sentrinelPlugin({
 *     serverUrl: 'http://localhost:3001',
 *     appName: 'my-api',
 *     env: 'prod',
 *     requestLogging: {
 *       enabled: true,
 *       logRequestHeaders: true,
 *       logRequestBody: true,
 *       logResponseBody: true,
 *     },
 *     consumerIdentifier: (ctx) => ctx.headers['x-consumer-id'],
 *   }))
 * ```
 */
function sentrinelPlugin(options) {
    return (app) => {
        const core = (0, core_1.createServerInstrumentation)(options, "Elysia plugin");
        app.onStop(async () => {
            await core.stop();
        });
        // Request payloads, captured before anything else can consume the stream.
        //
        // This has to happen in `onRequest`, not `derive`. `derive` runs at the
        // transform stage — *after* Elysia has parsed the body — and once it has,
        // cloning yields an already-drained stream that reads back as "" with no
        // error thrown. Elysia parses eagerly for any route that declares a `body`
        // schema, which in a typed app is nearly every POST/PUT/PATCH, so the
        // payload silently went missing on exactly the requests most worth having
        // it for. See tests/raw-payload.test.ts.
        //
        // Reading from a *clone* keeps the original stream untouched for the
        // handler, so a route that verifies a raw signature still sees its bytes.
        // Only the first `maxBodySize` bytes are read — the rest of the clone is
        // cancelled rather than buffered — and files, media and streams are not
        // read at all. It is awaited so the capture finishes before the handler
        // starts pulling: a tee buffers whatever one branch has read and the other
        // has not, and a slow capture racing a fast handler would buffer the body.
        //
        // Keyed by the Request itself, weakly, so nothing is retained after the
        // response is done.
        const capturedPayloads = new WeakMap();
        /**
         * The request's state, created in `onRequest` and looked up later by
         * identity.
         *
         * Both halves of that matter. It has to be built in `onRequest` because
         * the context handed to `derive` and the afterResponse hook is lazy:
         * reading *any* property off its `request` — even `.headers` — makes
         * Elysia resolve and parse the body, which drains the stream and 500s
         * routes that read it themselves. Using the same object purely as a
         * WeakMap key touches no property and is safe, which is why
         * `capturedPayloads` above gets away with it too.
         */
        const states = new WeakMap();
        app.onRequest(({ request }) => {
            try {
                const url = new URL(request.url);
                const state = core.begin(request.method, url, (name) => request.headers.get(name));
                states.set(request, state);
            }
            catch {
                // Telemetry is best-effort; never fail a request over it.
            }
        });
        if (options.requestLogging?.logRequestBody) {
            app.onRequest(async ({ request }) => {
                try {
                    const captured = await (0, body_1.peekBody)(request, core.maxBodySize);
                    if (captured?.text)
                        capturedPayloads.set(request, captured);
                }
                catch {
                    // A body that cannot be cloned/read is not worth failing the request
                    // over; telemetry is best-effort.
                }
            });
        }
        app.derive(({ request }) => {
            const state = states.get(request);
            if (!state)
                return {};
            // Open the trace, request-log and canonical scopes for the rest of this
            // request. Without this, traceSpan()/traced() find no store and
            // silently record nothing.
            core.enter(state);
            return {
                _sentrinelState: state,
                _sentrinelReqPayload: capturedPayloads.get(request),
            };
        });
        // Thrown exceptions never reach afterResponse with their stack intact —
        // Elysia has already turned them into a response by then. Capturing the
        // real Error here is what makes stack-trace fingerprinting (and therefore
        // issue grouping) work for genuine crashes rather than only for handlers
        // that happen to *return* an error-shaped object.
        app.onError((ctx) => {
            try {
                const err = ctx.error;
                if (err instanceof Error) {
                    ctx._sentrinelError = (0, core_1.errorShape)(err);
                }
            }
            catch { }
        });
        app.onAfterResponse((ctx) => {
            try {
                const state = ctx._sentrinelState;
                if (!state)
                    return;
                const pathname = state.url.pathname;
                // Check if this path is excluded
                if (core.isExcludedPath(pathname))
                    return;
                try {
                    if (options.excludeRequest?.(ctx.request))
                        return;
                }
                catch {
                    // A predicate that throws excludes nothing; telemetry is best-effort.
                }
                // Determine the route pattern (use Elysia's matched route if available)
                const routePath = ctx.route || pathname;
                // A returned Response carries its own status, and it is the one the
                // client received. `set.status` stays at its default 200 when a handler
                // returns `new Response(…, { status: 404 })`, so preferring it recorded
                // every such error as a success.
                const response = ctx.response;
                const setStatus = ctx.set?.status;
                const statusCode = typeof Response !== "undefined" && response instanceof Response
                    ? response.status
                    : typeof setStatus === "number"
                        ? setStatus
                        : typeof setStatus === "string"
                            ? ((0, core_1.statusFromName)(setStatus) ?? 200)
                            : 200;
                // Estimate sizes
                const requestSize = parseInt(ctx.request.headers.get("content-length") || "0", 10) || 0;
                let responseSize = 0;
                if (response !== null && response !== undefined) {
                    if (typeof Response !== "undefined" && response instanceof Response) {
                        responseSize = parseInt(response.headers.get("content-length") || "0", 10) || 0;
                    }
                    else if (typeof response === "string") {
                        responseSize = new TextEncoder().encode(response).byteLength;
                    }
                    else if (typeof response === "object") {
                        try {
                            responseSize = new TextEncoder().encode(JSON.stringify(response)).byteLength;
                        }
                        catch { }
                    }
                }
                // Get consumer identifier
                let consumer = null;
                if (typeof options.consumerIdentifier === "function") {
                    try {
                        // Hand the resolver an explicit, field-by-field view rather than
                        // the raw context. Passing the whole context to a function Elysia
                        // cannot inspect makes it assume every field is needed — including
                        // the request payload — so it eagerly parses every request and
                        // consumes the single-use stream, breaking handlers that read the
                        // raw request themselves. Naming the fields keeps the payload out
                        // of what Elysia infers as used. A resolver that needs the parsed
                        // payload is the rare exception and can read it from `request`.
                        const safeCtx = {
                            request: ctx.request,
                            headers: ctx.headers,
                            set: ctx.set,
                            query: ctx.query,
                            params: ctx.params,
                            store: ctx.store,
                            response: ctx.response,
                        };
                        consumer = options.consumerIdentifier(safeCtx);
                    }
                    catch { }
                }
                else if (typeof options.consumerIdentifier === "string") {
                    // Header-name shorthand, matching the Express/Next adapters.
                    consumer = ctx.request.headers.get(options.consumerIdentifier.toLowerCase());
                }
                const captured = ctx._sentrinelReqPayload;
                const request = ctx.request;
                core.finish(state, {
                    statusCode,
                    route: routePath,
                    error: ctx._sentrinelError,
                    consumer,
                    requestSize,
                    responseSize,
                    requestHeaders: () => {
                        const raw = {};
                        request.headers.forEach((value, key) => {
                            raw[key] = value;
                        });
                        return raw;
                    },
                    // Captured in onRequest from a clone — see there for why it must not
                    // be read from the context here.
                    requestBody: captured
                        ? {
                            text: captured.text,
                            truncated: captured.truncated,
                            totalBytes: requestSize || undefined,
                            contentType: request.headers.get("content-type"),
                        }
                        : undefined,
                    responseBody: response !== null && response !== undefined && !(typeof Response !== "undefined" && response instanceof Response)
                        ? { value: response }
                        : undefined,
                });
            }
            catch (err) {
                if (options.debug)
                    console.error("[sentrinel] Error in afterResponse hook:", err);
            }
        });
        return app;
    };
}
