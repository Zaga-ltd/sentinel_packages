"use strict";
// ─── Next.js middleware — `@sentrinel/plugin/next/middleware` ────────────────
//
// Kept only so an existing `middleware.ts` keeps working. It records nothing:
// Next middleware runs on the Edge runtime *before* the route, so it can see
// neither the status nor the duration of the response, and the Edge runtime
// has none of what the collector needs (`node:os`, `process.cpuUsage`,
// AsyncLocalStorage). Recording belongs in the route — `withSentrinel` in
// `@sentrinel/plugin/next`.
//
// The previous version returned `new Response(null, { status: 200 })` for
// every matched request. Next reads a middleware response without
// `x-middleware-next` as *the* response, so every route under the matcher
// came back blank. This returns the pass-through Next itself builds for
// `NextResponse.next()`.
//
// No imports on purpose: anything imported here is bundled for the Edge.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPassThrough = nextPassThrough;
exports.sentrinelNextMiddleware = sentrinelNextMiddleware;
/** `NextResponse.next()`, without depending on `next/server`. */
function nextPassThrough() {
    return new Response(null, { headers: { "x-middleware-next": "1" } });
}
/**
 * A middleware that lets every request through untouched.
 *
 * An incoming `traceparent` already reaches the route handler unchanged — a
 * pass-through forwards request headers as they are — and `withSentrinel`
 * continues it there. Minting one here would name a parent span nothing ever
 * records.
 *
 * @deprecated Wrap route handlers with `withSentrinel` from
 * `@sentrinel/plugin/next`; this middleware is not needed at all.
 */
function sentrinelNextMiddleware(_options) {
    let warned = false;
    const middleware = async (_request) => {
        const opts = _options;
        if (opts?.debug && !warned) {
            warned = true;
            console.warn("[sentrinel] sentrinelNextMiddleware records nothing — wrap your route handlers " +
                "with withSentrinel() from @sentrinel/plugin/next instead.");
        }
        return nextPassThrough();
    };
    return Object.assign(middleware, {
        /** @deprecated No-op; kept so old call sites compile. */
        recordResponse: (_request, _response) => { },
        /** @deprecated No-op. */
        stop: async () => { },
    });
}
