"use strict";
// ─── Application-log capture ─────────────────────────────────────────────────
//
// Patches console.{log,info,warn,error,debug} once and, while a request is
// being handled, copies each line into that request's buffer (correlated via
// AsyncLocalStorage). Console output still reaches stdout untouched.
//
// Design notes:
//  * enterWith() is used from Elysia's derive hook — each incoming request
//    starts a fresh async context in Bun, so buffers do not leak across
//    concurrent requests.
//  * Capture is bounded (maxPerRequest) and messages truncated, so a noisy
//    loop cannot balloon memory or payloads.
Object.defineProperty(exports, "__esModule", { value: true });
exports.instrumentConsole = instrumentConsole;
exports.beginRequestLogContext = beginRequestLogContext;
exports.createRequestLogContext = createRequestLogContext;
exports.enterRequestLogContext = enterRequestLogContext;
exports.runWithRequestLogContext = runWithRequestLogContext;
exports.drainRequestLogs = drainRequestLogs;
const node_async_hooks_1 = require("node:async_hooks");
const storage = new node_async_hooks_1.AsyncLocalStorage();
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
let patched = false;
let activeOptions = null;
function serialize(args, maxLen) {
    const text = args
        .map((a) => {
        if (typeof a === "string")
            return a;
        if (a instanceof Error)
            return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
        try {
            return JSON.stringify(a);
        }
        catch {
            return String(a);
        }
    })
        .join(" ");
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}
function capture(level, args) {
    const opts = activeOptions;
    if (!opts)
        return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[opts.minLevel])
        return;
    const ctx = storage.getStore();
    if (!ctx)
        return; // not inside a monitored request
    if (ctx.buffer.length >= opts.maxPerRequest) {
        ctx.dropped++;
        return;
    }
    ctx.buffer.push({
        timestamp: new Date().toISOString(),
        level,
        message: serialize(args, opts.maxMessageLength),
        requestId: ctx.requestId,
        seq: ctx.buffer.length,
    });
}
/** Patch console once. Idempotent; original behaviour is preserved. */
function instrumentConsole(options) {
    activeOptions = {
        enabled: options.enabled,
        minLevel: options.minLevel ?? "info",
        maxPerRequest: options.maxPerRequest ?? 50,
        maxMessageLength: options.maxMessageLength ?? 2000,
    };
    if (patched || !options.enabled)
        return;
    patched = true;
    const map = [
        ["debug", "debug"],
        ["log", "info"],
        ["info", "info"],
        ["warn", "warn"],
        ["error", "error"],
    ];
    for (const [method, level] of map) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            try {
                capture(level, args);
            }
            catch { }
            original(...args);
        };
    }
}
/** Called from the plugin's derive hook: opens this request's log context. */
function beginRequestLogContext(requestId) {
    const ctx = { requestId, buffer: [], dropped: 0 };
    storage.enterWith(ctx);
    return ctx;
}
/** A context not yet entered — pair with runWithRequestLogContext(). */
function createRequestLogContext(requestId) {
    return { requestId, buffer: [], dropped: 0 };
}
/** Enter an existing context for the rest of this async execution. */
function enterRequestLogContext(ctx) {
    storage.enterWith(ctx);
}
function runWithRequestLogContext(ctx, fn) {
    return storage.run(ctx, fn);
}
/** Called from afterResponse: drains and returns this request's lines. */
function drainRequestLogs(ctx = storage.getStore()) {
    if (!ctx)
        return { logs: [], dropped: 0 };
    const logs = ctx.buffer;
    const dropped = ctx.dropped;
    ctx.buffer = [];
    ctx.dropped = 0;
    return { logs, dropped };
}
