"use strict";
// ─── Structured, trace-connected logging ────────────────────────────────────
//
// The problem with conventional logging is that it optimises for *writing* —
// a human-readable sentence — when what you actually do with logs is *query*
// them. `console.log(\`user ${id} failed checkout\`)` is easy to write and
// impossible to ask questions of: you cannot filter by user, group by failure
// reason, or correlate it with the request that produced it.
//
// This logger takes the opposite position:
//
//   * A log is a **message plus attributes**, never an interpolated sentence.
//     `logger.warn("Checkout declined", { userId, reason, cartTotal })` is one
//     stable message you can group by, with high-cardinality fields you can
//     filter on.
//
//   * Every record is **automatically correlated** — request id, trace id and
//     span id are attached from the ambient context, so a log line always knows
//     which request and which span produced it. That is what makes "show me
//     everything that happened during this request" a lookup rather than a
//     grep.
//
//   * **Context is inherited, not repeated.** `withContext({ userId }, fn)`
//     attaches those fields to every log emitted anywhere inside `fn`, however
//     deep the call stack, so business context reaches logs written by code
//     that has never heard of a user.
//
//   * **Categories are hierarchical** (`["api", "checkout"]`), so you can filter
//     a whole subsystem without inventing a naming convention.
//
// Nothing here blocks the request path: records go into an in-memory buffer the
// collector flushes on its normal interval.
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.withContext = withContext;
exports.addContext = addContext;
exports.currentContext = currentContext;
exports.enterContext = enterContext;
exports.setCorrelationSource = setCorrelationSource;
exports.enterRequestScope = enterRequestScope;
exports.runInRequestScope = runInRequestScope;
exports.clearRequestScope = clearRequestScope;
exports.currentRequestId = currentRequestId;
exports.beginCanonicalScope = beginCanonicalScope;
exports.createCanonicalScope = createCanonicalScope;
exports.enterCanonicalScope = enterCanonicalScope;
exports.runInCanonicalScope = runInCanonicalScope;
exports.drainCanonicalScope = drainCanonicalScope;
exports.addRequestContext = addRequestContext;
exports.drainCanonicalFields = drainCanonicalFields;
exports.setLogSink = setLogSink;
exports.resetLogSink = resetLogSink;
exports.setLogEcho = setLogEcho;
exports.setLogLevel = setLogLevel;
exports.getLogger = getLogger;
const node_async_hooks_1 = require("node:async_hooks");
const contextStorage = new node_async_hooks_1.AsyncLocalStorage();
/**
 * Run `fn` with these fields attached to every log emitted inside it.
 *
 * Nested scopes merge, inner winning, so a request-level scope can set
 * `{ tenantId }` and a handler can add `{ orderId }` without either knowing
 * about the other.
 */
function withContext(fields, fn) {
    const parent = contextStorage.getStore() ?? {};
    return contextStorage.run({ ...parent, ...fields }, fn);
}
/**
 * Add fields to the *current* scope without nesting a callback.
 *
 * Useful in middleware that has no wrapping function to hand — but it only
 * affects the current async context, so prefer withContext() when you can.
 */
function addContext(fields) {
    const store = contextStorage.getStore();
    if (store)
        Object.assign(store, fields);
}
/** The context that would be attached to a log right now. */
function currentContext() {
    return { ...(contextStorage.getStore() ?? {}) };
}
/** Opens a context scope for the remainder of this async execution. */
function enterContext(fields) {
    contextStorage.enterWith({ ...(contextStorage.getStore() ?? {}), ...fields });
}
let correlationSource = null;
function setCorrelationSource(fn) {
    correlationSource = fn;
}
const requestStorage = new node_async_hooks_1.AsyncLocalStorage();
/** Opens the request scope for the rest of this async execution. */
function enterRequestScope(requestId, sink) {
    requestStorage.enterWith({ requestId, sink });
}
/**
 * Run `fn` inside a request scope that ends when it does.
 *
 * The adapters that wrap a handler (Express, Next, Bun) use this rather than
 * enterWith(): enterWith() inside an async wrapper changes the *caller's*
 * context too, so the framework's code after the handler returned would go on
 * attributing its logs to a request that had finished.
 */
function runInRequestScope(requestId, sink, fn) {
    return requestStorage.run({ requestId, sink }, fn);
}
/**
 * Leave the request scope.
 *
 * enterWith() has no natural end — it persists for the remainder of the async
 * execution. That is what you want per request, but a worker that keeps running
 * after a request finishes would otherwise go on attributing its logs to it.
 */
function clearRequestScope() {
    requestStorage.enterWith({ requestId: "" });
}
function currentRequestId() {
    return requestStorage.getStore()?.requestId || undefined;
}
const canonicalStorage = new node_async_hooks_1.AsyncLocalStorage();
/** Opens the canonical-field collector for this request. */
function beginCanonicalScope() {
    const scope = { fields: {} };
    canonicalStorage.enterWith(scope);
    return scope;
}
/** A canonical scope not yet entered — pair with runInCanonicalScope(). */
function createCanonicalScope() {
    return { fields: {} };
}
/** Enter an existing scope for the rest of this async execution. */
function enterCanonicalScope(scope) {
    canonicalStorage.enterWith(scope);
}
function runInCanonicalScope(scope, fn) {
    return canonicalStorage.run(scope, fn);
}
/**
 * Drain a scope held by reference.
 *
 * The recording step of an adapter runs from a response event, whose async
 * context is not reliably the handler's — reading the ambient store there can
 * find nothing, or another request's fields. Holding the scope object and
 * draining it directly cannot.
 */
function drainCanonicalScope(scope) {
    if (!scope || !Object.keys(scope.fields).length)
        return undefined;
    const fields = { ...scope.fields };
    scope.fields = {};
    return fields;
}
/**
 * Attach business context to *this request's* canonical event.
 *
 * Call it anywhere in the handler, as many times as you like:
 *
 *   addRequestContext({ tier: user.tier, cartTotal, experiment: "new-pricing" });
 */
function addRequestContext(fields) {
    const store = canonicalStorage.getStore();
    if (store)
        Object.assign(store.fields, fields);
}
/** Drains the fields collected for this request. */
function drainCanonicalFields() {
    const store = canonicalStorage.getStore();
    if (!store || !Object.keys(store.fields).length)
        return undefined;
    const fields = { ...store.fields };
    store.fields = {};
    return fields;
}
/**
 * The sink for logs written outside any request — startup, background jobs,
 * schedulers. The *first* plugin to register wins, because in a multi-app
 * process there is no better answer than "the app that booted first", and
 * silently reassigning it on every later registration is worse.
 */
let defaultSink = null;
/** Records emitted before any plugin starts, so nothing is lost at boot. */
const pending = [];
const MAX_PENDING = 500;
function setLogSink(fn) {
    if (!defaultSink) {
        defaultSink = fn;
        while (pending.length)
            fn(pending.shift());
    }
}
/** Test seam — lets a suite install a fresh sink. */
function resetLogSink() {
    defaultSink = null;
    pending.length = 0;
}
/** Mirror records to stdout as JSON. Off by default — the app owns its output. */
let echo = false;
function setLogEcho(on) {
    echo = on;
}
let minLevel = "debug";
function setLogLevel(level) {
    minLevel = level;
}
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
/**
 * `{placeholder}` in a message is replaced from attributes or context.
 *
 * The *stored* message keeps its placeholders, so every occurrence groups
 * together no matter what the values were — the values are already in the
 * attributes, where they can be filtered. Interpolation is only for the
 * human-readable echo.
 */
function interpolate(message, values) {
    return message.replace(/\{(\w+)\}/g, (whole, key) => key in values ? String(values[key]) : whole);
}
function emit(level, category, message, attributes) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel])
        return;
    const context = contextStorage.getStore();
    const merged = context || attributes ? { ...(context ?? {}), ...(attributes ?? {}) } : undefined;
    const correlation = correlationSource?.() ?? {};
    const record = {
        timestamp: new Date().toISOString(),
        level,
        message,
        category,
        attributes: merged && Object.keys(merged).length ? merged : undefined,
        ...correlation,
    };
    if (echo) {
        // Human-readable line for local development; the structured record is what
        // gets shipped.
        const rendered = merged ? interpolate(message, merged) : message;
        const suffix = merged ? " " + JSON.stringify(merged) : "";
        const tag = category ? `[${category}] ` : "";
        process.stdout.write(`${record.timestamp} ${level.toUpperCase().padEnd(5)} ${tag}${rendered}${suffix}\n`);
    }
    // Inside a request, the log belongs to the app that is handling it — not to
    // whichever plugin happened to register last.
    const target = requestStorage.getStore()?.sink ?? defaultSink;
    if (target)
        target(record);
    else if (pending.length < MAX_PENDING)
        pending.push(record);
}
function makeLogger(parts, bound) {
    const category = parts.join(".");
    const log = (level) => (message, attributes) => {
        const merged = Object.keys(bound).length || attributes ? { ...bound, ...(attributes ?? {}) } : undefined;
        emit(level, category || undefined, message, merged);
    };
    return {
        category,
        debug: log("debug"),
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
        getChild: (child) => makeLogger([...parts, ...toParts(child)], bound),
        with: (attributes) => makeLogger(parts, { ...bound, ...attributes }),
    };
}
function toParts(category) {
    if (!category)
        return [];
    return Array.isArray(category) ? category.filter(Boolean) : category.split(".").filter(Boolean);
}
/**
 * Get a logger, optionally under a category.
 *
 *   const log = getLogger(["api", "checkout"]);
 *   log.info("Payment authorized", { orderId, amount, provider: "stripe" });
 *
 * Cheap to call — create one per module at import time, or inline.
 */
function getLogger(category) {
    return makeLogger(toParts(category), {});
}
/** The root logger, for code that has nothing more specific to say. */
exports.logger = getLogger();
