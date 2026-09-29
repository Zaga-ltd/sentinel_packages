import { AsyncLocalStorage } from "node:async_hooks";
export interface Span {
    id: string;
    traceId: string;
    parentId?: string;
    name: string;
    kind?: string;
    startTime: string;
    endTime?: string;
    durationMs: number;
    attributes: Record<string, any>;
    statusCode?: "OK" | "ERROR" | "UNSET";
    statusMessage?: string;
}
export interface TraceContext {
    traceId: string;
    rootSpanId: string;
    /**
     * The span that is running in *this* async context. Never mutated in place:
     * each span runs in its own copy of the store — see runInSpan().
     */
    currentSpanId: string;
    /** Shared by every copy of the store for one request. */
    spans: Span[];
    /**
     * The caller's span id, when this request arrived with `traceparent`.
     *
     * Distinct from `currentSpanId`, which differs per span. This one is fixed
     * for the request and is what the server span records as its parent, so a
     * mobile or browser client's span and the server work it caused join into
     * one tree instead of two roots sharing a trace id.
     */
    inboundSpanId?: string;
    /** Spans not kept because the trace hit MAX_SPANS_PER_TRACE. */
    droppedSpans?: number;
}
export declare const traceStorage: AsyncLocalStorage<TraceContext>;
/** Helper to generate 32-char hex traceId (OTLP format) */
export declare function generateTraceId(): string;
/** Helper to generate 16-char hex spanId (OTLP format) */
export declare function generateSpanId(): string;
/**
 * Generates an RFC 9562 compliant UUID v7 identifier.
 * Embeds a 48-bit UNIX millisecond timestamp + monotonic sequence counter at the front of the 128-bit UUID.
 * Guarantees time-sortability and eliminates B-Tree index page splitting on database tables.
 */
export declare function generateUuidV7(): string;
/**
 * Parses W3C traceparent (00-{traceId}-{parentSpanId}-01) or x-trace-id header from incoming Mobile/Web client requests.
 */
export declare function parseTraceParent(header: string | null | undefined): {
    traceId: string;
    parentSpanId?: string;
} | null;
/**
 * Generates W3C compliant traceparent header string (00-{traceId}-{spanId}-01).
 */
export declare function createTraceParentHeader(traceId?: string, spanId?: string): string;
/**
 * Client-side tracing helper for non-browser clients (scripts, CLIs, workers).
 *
 * In a web page use `@sentrinel/plugin/browser` instead: this module imports
 * node built-ins, and the browser SDK already propagates `traceparent` per
 * request on its patched `fetch`.
 *
 * @example
 * const tracer = createClientTracer({ clientName: "billing-cron" });
 * const res = await tracer.traceFetch("https://api.myapp.com/v1/checkout");
 */
export declare function createClientTracer(config?: {
    clientName?: string;
}): {
    getHeaders(existingHeaders?: Record<string, string>): {
        traceparent: string;
        "x-trace-id": string;
        "x-consumer-id": string;
    };
    traceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};
/** Spans kept per trace. The ingest refuses a trace with more — all of it. */
export declare const MAX_SPANS_PER_TRACE = 1000;
/** What the function running inside a span can do to it. */
export interface SpanHandle {
    setAttribute: (key: string, value: any) => void;
    /** Mark the span failed without throwing — for errors a caller handles. */
    setStatus: (status: "OK" | "ERROR", message?: string) => void;
    /** Empty outside a request, where nothing is recorded. */
    readonly spanId: string;
    readonly traceId: string;
}
/**
 * Run `fn` as a span, returning exactly what it returns.
 *
 * Two properties the old implementation lacked, both of which it needed:
 *
 *   1. **Each span runs in its own async context.** The parent used to be
 *      tracked by mutating `currentSpanId` on the request's shared store, so
 *      `Promise.all([a(), b()])` recorded `b` as a child of `a` — whichever
 *      started second saw the first one's id as "current". A fresh store per
 *      span (sharing the request's `spans` array) gives every branch its own
 *      notion of "current" that nothing else can overwrite.
 *
 *   2. **Synchronous functions stay synchronous.** `traced(fn)` used to return
 *      an async wrapper, so wrapping a sync helper changed its return type to a
 *      Promise and broke every caller that used the value directly. A promise
 *      result is finished when it settles; anything else is finished now.
 */
export declare function runInSpan<T>(name: string, attributes: Record<string, any>, kind: string, fn: (span: SpanHandle) => T): T;
/**
 * Execute an async or synchronous function within an inner span.
 * Automatically inherits traceId and parentSpanId from the current HTTP request context.
 *
 * Always returns a Promise — use `traced()` to wrap a synchronous function
 * without making it async.
 *
 * @example
 * ```ts
 * const user = await traceSpan('db.query.findUser', async () => {
 *   return db.users.findById(id);
 * }, { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM users WHERE id = $1' });
 * ```
 */
export declare function traceSpan<T>(name: string, fn: (span: SpanHandle) => Promise<T> | T, attributes?: Record<string, any>, kind?: string): Promise<T>;
export declare function traceSpan<T>(name: string, options: {
    kind?: string;
    attributes?: Record<string, any>;
} & Record<string, any>, fn: (span: SpanHandle) => Promise<T> | T): Promise<T>;
/**
 * Super short 1-line alias for traceSpan.
 *
 * @example
 * const user = await tspan('db.findUser', () => db.find(id));
 */
export declare const tspan: typeof traceSpan;
/**
 * Wrap any function to automatically trace it whenever called.
 * Infers function name automatically if a named function is passed!
 *
 * The wrapper returns what the function returns: a synchronous function stays
 * synchronous, an async one still returns its promise.
 *
 * @example
 * const getProducts = traced(async function getProducts() {
 *   return db.products.find();
 * });
 *
 * const fetchUser = traced('db.fetchUser', (id) => db.users.find(id));
 */
export declare function traced<T extends (...args: any[]) => any>(nameOrFn: string | T, fn?: T, attributes?: Record<string, any>): T;
/**
 * Automatically instrument an entire service object or DB client!
 * Every method on the object will automatically generate an inner trace span
 * without any boilerplate code. Synchronous methods stay synchronous.
 *
 * @example
 * const db = traceObject(new DatabaseClient(), "db");
 * await db.findUser(123); // Automatically creates span 'db.findUser'!
 * await db.getLoans();    // Automatically creates span 'db.getLoans'!
 */
export declare function traceObject<T extends object>(target: T, namePrefix?: string): T;
/**
 * Auto-traced fetch wrapper. Creates an HTTP client span for the outgoing call
 * and sends `traceparent` naming that span, so the service on the other end
 * continues this trace instead of starting its own.
 *
 * A `traceparent` the caller set is left alone. Outside a request there is no
 * trace to continue, so the call goes out unchanged.
 *
 * @example
 * const res = await sentrinelFetch("https://api.stripe.com/v1/charges", { method: "POST" });
 */
export declare function sentrinelFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
