"use strict";
// ─── Delivery retry ──────────────────────────────────────────────────────────
//
// Telemetry used to be dropped the instant a flush failed: the buffer was
// emptied, the payload was posted, and if the post failed the records were
// already gone. A restart of the API, a ClickHouse hiccup, a thirty-second
// network blip — each one silently cost you the window it covered.
//
// This holds failed payloads and re-sends them, with three rules that matter
// more than the retry itself:
//
//   1. **Bounded.** Memory is the app's, not ours. Past the cap the *oldest*
//      payload is dropped, because in an outage the newest data is the data
//      someone is staring at a dashboard waiting for. The cap is on bytes as
//      well as count: a request-log batch can be megabytes, and a hundred of
//      them is not a number anyone meant when they set "100".
//
//   2. **Only what retrying can fix.** A 401 or a 422 will fail identically
//      forever; retrying it wastes the queue on a payload that can never land
//      and delays the ones that could. Network errors, timeouts, 5xx and 429
//      are retried; other 4xx are dropped immediately.
//
//   3. **Backed off, with jitter.** Every instance of a service restarts its
//      collector at the same moment, so a fixed delay means they all retry in
//      lockstep and hit a recovering API together.
//
// The collector keeps one queue per payload type, so an outage that fills the
// queue with request logs cannot evict the small metrics batches the headline
// numbers are built from.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryQueue = void 0;
exports.isRetryable = isRetryable;
const DEFAULTS = {
    maxQueued: 100,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxAttempts: 5,
    baseDelayMs: 5000,
    maxDelayMs: 300000,
};
/**
 * Is this failure worth trying again?
 *
 * `status` is undefined for a transport error — DNS, TLS, connection refused,
 * a timeout — which is the most retryable case there is.
 */
function isRetryable(status) {
    if (status === undefined)
        return true; // never reached the server
    if (status === 408)
        return true; // the server gave up waiting; try again
    if (status === 429)
        return true; // rate limited: back off and retry
    if (status >= 500)
        return true; // their problem, probably temporary
    return false; // 4xx: the payload or the key is wrong, and will stay wrong
}
class RetryQueue {
    constructor(options = {}) {
        this.queue = [];
        this.bytes = 0;
        /** Counted rather than logged per-item, so an outage warns once. */
        this.droppedForSpace = 0;
        this.droppedForAttempts = 0;
        const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
        this.opts = { ...DEFAULTS, ...defined };
    }
    get size() {
        return this.queue.length;
    }
    /** Serialized bytes currently held. */
    get queuedBytes() {
        return this.bytes;
    }
    /** Payloads discarded since the last report, and why. */
    drainDropCounts() {
        const counts = { space: this.droppedForSpace, attempts: this.droppedForAttempts };
        this.droppedForSpace = 0;
        this.droppedForAttempts = 0;
        return counts;
    }
    /**
     * Hold a payload for a later attempt.
     *
     * Returns false when it was dropped instead — either the failure is not
     * retryable, or it has already had every attempt it is going to get.
     */
    enqueue(path, body, status, attempts = 0, bytes = 0) {
        if (!isRetryable(status))
            return false;
        if (attempts + 1 >= this.opts.maxAttempts) {
            this.droppedForAttempts++;
            return false;
        }
        const next = attempts + 1;
        // 5s, 10s, 20s, 40s… capped. Jitter spreads a fleet that all restarted
        // together, so a recovering API is not hit by every instance at once.
        const backoff = Math.min(this.opts.baseDelayMs * 2 ** attempts, this.opts.maxDelayMs);
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        this.queue.push({
            path,
            body,
            attempts: next,
            nextAttemptAt: Date.now() + jitter,
            queuedAt: Date.now(),
            bytes,
        });
        this.bytes += bytes;
        // Oldest out, not newest: during an outage the recent window is the one
        // worth keeping, and the stale end is the part nobody will look at. The
        // newest payload is kept even if it alone is over the byte budget —
        // refusing it would drop the freshest data to protect staler data.
        while (this.queue.length > 1 &&
            (this.queue.length > this.opts.maxQueued || this.bytes > this.opts.maxQueuedBytes)) {
            const dropped = this.queue.shift();
            this.bytes -= dropped.bytes;
            this.droppedForSpace++;
        }
        if (this.queue.length > this.opts.maxQueued) {
            // maxQueued of 0: hold nothing.
            const dropped = this.queue.shift();
            this.bytes -= dropped.bytes;
            this.droppedForSpace++;
            return false;
        }
        return true;
    }
    /** Everything whose backoff has elapsed, removed from the queue. */
    due(now = Date.now()) {
        if (!this.queue.length)
            return [];
        const ready = [];
        const waiting = [];
        for (const item of this.queue) {
            (item.nextAttemptAt <= now ? ready : waiting).push(item);
        }
        this.queue = waiting;
        this.bytes = waiting.reduce((sum, i) => sum + i.bytes, 0);
        return ready;
    }
    /** Everything, due or not — the last attempt at shutdown. */
    takeAll() {
        const all = this.queue;
        this.queue = [];
        this.bytes = 0;
        return all;
    }
    /** Drop everything — used on shutdown once a final flush has been tried. */
    clear() {
        this.queue = [];
        this.bytes = 0;
    }
}
exports.RetryQueue = RetryQueue;
