export interface QueuedPayload {
    path: string;
    body: unknown;
    /** How many sends have already failed for this payload. */
    attempts: number;
    /** Earliest time this should be tried again, ms since epoch. */
    nextAttemptAt: number;
    /** For the "dropped N" accounting, so a drop is never silent. */
    queuedAt: number;
    /** Serialized size, for the byte budget. */
    bytes: number;
}
export interface RetryOptions {
    /** Payloads held at once. Beyond this the oldest is dropped. */
    maxQueued?: number;
    /** Serialized bytes held at once. Beyond this the oldest is dropped. */
    maxQueuedBytes?: number;
    /** Attempts per payload before it is abandoned. */
    maxAttempts?: number;
    /** First backoff step; doubles each attempt. */
    baseDelayMs?: number;
    /** Ceiling for the backoff. */
    maxDelayMs?: number;
}
/**
 * Is this failure worth trying again?
 *
 * `status` is undefined for a transport error — DNS, TLS, connection refused,
 * a timeout — which is the most retryable case there is.
 */
export declare function isRetryable(status?: number): boolean;
export declare class RetryQueue {
    private queue;
    private bytes;
    private readonly opts;
    /** Counted rather than logged per-item, so an outage warns once. */
    private droppedForSpace;
    private droppedForAttempts;
    constructor(options?: RetryOptions);
    get size(): number;
    /** Serialized bytes currently held. */
    get queuedBytes(): number;
    /** Payloads discarded since the last report, and why. */
    drainDropCounts(): {
        space: number;
        attempts: number;
    };
    /**
     * Hold a payload for a later attempt.
     *
     * Returns false when it was dropped instead — either the failure is not
     * retryable, or it has already had every attempt it is going to get.
     */
    enqueue(path: string, body: unknown, status: number | undefined, attempts?: number, bytes?: number): boolean;
    /** Everything whose backoff has elapsed, removed from the queue. */
    due(now?: number): QueuedPayload[];
    /** Everything, due or not — the last attempt at shutdown. */
    takeAll(): QueuedPayload[];
    /** Drop everything — used on shutdown once a final flush has been tried. */
    clear(): void;
}
