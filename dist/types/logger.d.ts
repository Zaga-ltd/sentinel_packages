import type { LogLevel } from "./logs.js";
export interface LogRecord {
    timestamp: string;
    level: LogLevel;
    /** The stable, low-cardinality message. Group by this. */
    message: string;
    /** Dotted category path, e.g. "api.checkout". */
    category?: string;
    /** Merged explicit attributes + inherited context. Filter by these. */
    attributes?: Record<string, unknown>;
    requestId?: string;
    traceId?: string;
    spanId?: string;
    /** Ordering within a request when timestamps collide. */
    seq?: number;
}
/** Fields inherited by every log emitted inside a withContext() scope. */
export type LogContext = Record<string, unknown>;
/**
 * Run `fn` with these fields attached to every log emitted inside it.
 *
 * Nested scopes merge, inner winning, so a request-level scope can set
 * `{ tenantId }` and a handler can add `{ orderId }` without either knowing
 * about the other.
 */
export declare function withContext<T>(fields: LogContext, fn: () => T): T;
/**
 * Add fields to the *current* scope without nesting a callback.
 *
 * Useful in middleware that has no wrapping function to hand — but it only
 * affects the current async context, so prefer withContext() when you can.
 */
export declare function addContext(fields: LogContext): void;
/** The context that would be attached to a log right now. */
export declare function currentContext(): LogContext;
/** Opens a context scope for the remainder of this async execution. */
export declare function enterContext(fields: LogContext): void;
export interface Correlation {
    requestId?: string;
    traceId?: string;
    spanId?: string;
}
export declare function setCorrelationSource(fn: () => Correlation): void;
/** Opens the request scope for the rest of this async execution. */
export declare function enterRequestScope(requestId: string, sink?: LogSink): void;
/**
 * Run `fn` inside a request scope that ends when it does.
 *
 * The adapters that wrap a handler (Express, Next, Bun) use this rather than
 * enterWith(): enterWith() inside an async wrapper changes the *caller's*
 * context too, so the framework's code after the handler returned would go on
 * attributing its logs to a request that had finished.
 */
export declare function runInRequestScope<T>(requestId: string, sink: LogSink | undefined, fn: () => T): T;
/**
 * Leave the request scope.
 *
 * enterWith() has no natural end — it persists for the remainder of the async
 * execution. That is what you want per request, but a worker that keeps running
 * after a request finishes would otherwise go on attributing its logs to it.
 */
export declare function clearRequestScope(): void;
export declare function currentRequestId(): string | undefined;
/** One request's canonical fields. Held by reference so they can be drained anywhere. */
export interface CanonicalScope {
    fields: Record<string, unknown>;
}
/** Opens the canonical-field collector for this request. */
export declare function beginCanonicalScope(): CanonicalScope;
/** A canonical scope not yet entered — pair with runInCanonicalScope(). */
export declare function createCanonicalScope(): CanonicalScope;
/** Enter an existing scope for the rest of this async execution. */
export declare function enterCanonicalScope(scope: CanonicalScope): void;
export declare function runInCanonicalScope<T>(scope: CanonicalScope, fn: () => T): T;
/**
 * Drain a scope held by reference.
 *
 * The recording step of an adapter runs from a response event, whose async
 * context is not reliably the handler's — reading the ambient store there can
 * find nothing, or another request's fields. Holding the scope object and
 * draining it directly cannot.
 */
export declare function drainCanonicalScope(scope: CanonicalScope | undefined): Record<string, unknown> | undefined;
/**
 * Attach business context to *this request's* canonical event.
 *
 * Call it anywhere in the handler, as many times as you like:
 *
 *   addRequestContext({ tier: user.tier, cartTotal, experiment: "new-pricing" });
 */
export declare function addRequestContext(fields: Record<string, unknown>): void;
/** Drains the fields collected for this request. */
export declare function drainCanonicalFields(): Record<string, unknown> | undefined;
export type LogSink = (record: LogRecord) => void;
export declare function setLogSink(fn: LogSink): void;
/** Test seam — lets a suite install a fresh sink. */
export declare function resetLogSink(): void;
export declare function setLogEcho(on: boolean): void;
export declare function setLogLevel(level: LogLevel): void;
export interface Logger {
    debug(message: string, attributes?: Record<string, unknown>): void;
    info(message: string, attributes?: Record<string, unknown>): void;
    warn(message: string, attributes?: Record<string, unknown>): void;
    error(message: string, attributes?: Record<string, unknown>): void;
    /**
     * A child logger under a nested category. `getLogger("api").getChild("auth")`
     * logs as "api.auth", so you can filter a subsystem or one route.
     */
    getChild(category: string | string[]): Logger;
    /** A logger whose records always carry these attributes. */
    with(attributes: Record<string, unknown>): Logger;
    readonly category: string;
}
/**
 * Get a logger, optionally under a category.
 *
 *   const log = getLogger(["api", "checkout"]);
 *   log.info("Payment authorized", { orderId, amount, provider: "stripe" });
 *
 * Cheap to call — create one per module at import time, or inline.
 */
export declare function getLogger(category?: string | string[]): Logger;
/** The root logger, for code that has nothing more specific to say. */
export declare const logger: Logger;
