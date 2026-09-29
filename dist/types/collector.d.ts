import type { SentrinelPluginOptions, RequestLogEntry, ErrorPayload, AppLogsPayload, TraceRecord } from "./types.js";
export declare class MetricsCollector {
    private endpointMetrics;
    private consumerMetrics;
    private requestLogBuffer;
    private appLogBuffer;
    private errorBuffer;
    private traceBuffer;
    private flushTimer;
    private options;
    private readonly limits;
    private readonly sendTimeoutMs;
    private dropped;
    /** Problems already reported, so a broken pipe warns once, not every flush. */
    private warned;
    /**
     * Payloads a failed send is holding on to, one queue per payload type.
     *
     * One shared queue let an outage fill every slot with request-log batches,
     * which then evicted the small metrics batches every headline number is built
     * from. Separate budgets mean the cheap, important data survives the big,
     * sampled data.
     */
    private retries;
    /** The flush running now, if any. */
    private inFlight;
    /** A flush requested while one was running; shared by every such caller. */
    private followUp;
    /** Set during the last flush: failures are not re-queued, nothing will retry them. */
    private finalFlush;
    private started;
    private lastCpuUsage;
    private lastCpuTime;
    constructor(options: SentrinelPluginOptions);
    /** Start the periodic flush timer */
    start(): void;
    /**
     * Stop the collector and perform a final flush.
     *
     * Waits for a flush already in flight, then sends what arrived since and
     * makes one last attempt at anything held for retry. It used to return early
     * when a flush was running, so a shutdown that coincided with the timer lost
     * the tail of the buffer.
     */
    stop(): Promise<void>;
    /** One last flush that tries everything and re-queues nothing. */
    finalFlushNow(): Promise<void>;
    /** Is anything waiting to be sent? */
    hasPendingData(): boolean;
    /** Record a request metric */
    recordRequest(data: {
        method: string;
        path: string;
        statusCode: number;
        responseTime: number;
        requestSize: number;
        responseSize: number;
        consumerIdentifier?: string | null;
        consumerName?: string;
        consumerGroup?: string;
    }): void;
    /** Record an error */
    recordError(error: ErrorPayload["errors"][0]): void;
    /** Record a full request log entry */
    recordRequestLog(entry: RequestLogEntry): void;
    /** Record application log lines captured during a request */
    recordAppLogs(logs: AppLogsPayload["logs"]): void;
    /** Record a completed trace (root span + any spans the handler recorded) */
    recordTrace(trace: TraceRecord): void;
    /**
     * Flush all buffered data to the Sentrinel API.
     *
     * Never skipped: a flush requested while one is running is queued behind it
     * (one follow-up however many callers ask), where it used to return at once
     * — so a send hanging on a dead connection silently disabled every later
     * flush. Sends now time out, so a flush always finishes.
     */
    flush(): Promise<void>;
    private doFlush;
    /** One line per flush that had to drop something — never silent, never per record. */
    private reportDrops;
    /** Build the metrics payload from the current buffer */
    private buildMetricsPayload;
    private retryQueueFor;
    /**
     * Send a payload, holding it for another attempt if the failure looks
     * temporary. `attempts` is how many sends have already failed for this exact
     * payload — 0 for a fresh one, higher when the retry queue hands it back.
     */
    private sendToServer;
    /**
     * Re-send whatever has come due, before this flush's own payloads.
     *
     * Order matters: retries first keeps the queue draining during a partial
     * outage instead of being permanently overtaken by fresh data. `all` takes
     * everything regardless of backoff — the last chance, at shutdown.
     */
    private drainRetries;
    /** How many payloads are waiting to be retried — surfaced for tests. */
    get pendingRetries(): number;
    /**
     * Report a problem once per kind. A broken pipe flushes on every interval;
     * logging each failure would bury the app's own output.
     */
    private warnOnce;
    private log;
}
/**
 * Halve a payload along its arrays. Null when there is nothing left to halve —
 * a single record the server still refuses.
 */
export declare function splitPayload(path: string, payload: any): any[] | null;
