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
//      someone is staring at a dashboard waiting for.
//
//   2. **Only what retrying can fix.** A 401 or a 422 will fail identically
//      forever; retrying it wastes the queue on a payload that can never land
//      and delays the ones that could. Network errors, timeouts, 5xx and 429
//      are retried; other 4xx are dropped immediately.
//
//   3. **Backed off, with jitter.** Every instance of a service restarts its
//      collector at the same moment, so a fixed delay means they all retry in
//      lockstep and hit a recovering API together.

export interface QueuedPayload {
  path: string;
  body: unknown;
  /** How many sends have already failed for this payload. */
  attempts: number;
  /** Earliest time this should be tried again, ms since epoch. */
  nextAttemptAt: number;
  /** For the "dropped N" accounting, so a drop is never silent. */
  queuedAt: number;
}

export interface RetryOptions {
  /** Payloads held at once. Beyond this the oldest is dropped. */
  maxQueued?: number;
  /** Attempts per payload before it is abandoned. */
  maxAttempts?: number;
  /** First backoff step; doubles each attempt. */
  baseDelayMs?: number;
  /** Ceiling for the backoff. */
  maxDelayMs?: number;
}

const DEFAULTS = {
  maxQueued: 100,
  maxAttempts: 5,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
};

/**
 * Is this failure worth trying again?
 *
 * `status` is undefined for a transport error — DNS, TLS, connection refused —
 * which is the most retryable case there is.
 */
export function isRetryable(status?: number): boolean {
  if (status === undefined) return true; // never reached the server
  if (status === 429) return true; // rate limited: back off and retry
  if (status >= 500) return true; // their problem, probably temporary
  return false; // 4xx: the payload or the key is wrong, and will stay wrong
}

export class RetryQueue {
  private queue: QueuedPayload[] = [];
  private readonly opts: Required<RetryOptions>;
  /** Counted rather than logged per-item, so an outage warns once. */
  private droppedForSpace = 0;
  private droppedForAttempts = 0;

  constructor(options: RetryOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get size(): number {
    return this.queue.length;
  }

  /** Payloads discarded since the last report, and why. */
  drainDropCounts(): { space: number; attempts: number } {
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
  enqueue(path: string, body: unknown, status: number | undefined, attempts = 0): boolean {
    if (!isRetryable(status)) return false;

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
    });

    // Oldest out, not newest: during an outage the recent window is the one
    // worth keeping, and the stale end is the part nobody will look at.
    while (this.queue.length > this.opts.maxQueued) {
      this.queue.shift();
      this.droppedForSpace++;
    }

    return true;
  }

  /** Everything whose backoff has elapsed, removed from the queue. */
  due(now = Date.now()): QueuedPayload[] {
    if (!this.queue.length) return [];
    const ready: QueuedPayload[] = [];
    const waiting: QueuedPayload[] = [];
    for (const item of this.queue) {
      (item.nextAttemptAt <= now ? ready : waiting).push(item);
    }
    this.queue = waiting;
    return ready;
  }

  /** Drop everything — used on shutdown once a final flush has been tried. */
  clear(): void {
    this.queue = [];
  }
}
