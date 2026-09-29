export type MetricKind = "counter" | "gauge" | "histogram";
export type MetricLabels = Record<string, string | number | boolean>;
export interface MetricPoint {
    name: string;
    kind: MetricKind;
    /** Canonical JSON with sorted keys — the series identity. */
    labels: string;
    unit?: string;
    count: number;
    sum: number;
    min: number;
    max: number;
    last: number;
    p50: number;
    p95: number;
    p99: number;
    timestamp: string;
}
export declare class MetricRegistry {
    private series;
    /** Series dropped because MAX_SERIES was reached. Surfaced for diagnostics. */
    droppedSeries: number;
    record(name: string, kind: MetricKind, value: number, labels?: MetricLabels, unit?: string): void;
    /** Number of live series. Exposed for tests and diagnostics. */
    get size(): number;
    /**
     * Take everything buffered and reset.
     *
     * Gauges reset with the rest: a gauge that stops being reported should leave
     * a gap in the chart rather than a flat line implying the last value is still
     * true.
     */
    drain(now?: Date): MetricPoint[];
}
export declare function metricRegistry(): MetricRegistry;
/**
 * Add to a running total: tokens, revenue, retries, items sold.
 *
 * ```ts
 * count("llm.tokens", usage.input_tokens, { model, direction: "input" });
 * count("revenue.usd", order.total, { plan: "pro" });
 * ```
 *
 * Safe to call in a hot loop — increments fold in memory and one row per
 * series leaves per flush.
 */
export declare function count(name: string, value?: number, labels?: MetricLabels, unit?: string): void;
/**
 * Report a level that goes up and down: queue depth, connections, cache size.
 *
 * The last value in a flush window wins — a gauge is a reading, not a total.
 */
export declare function gauge(name: string, value: number, labels?: MetricLabels, unit?: string): void;
/**
 * Record a distribution: cost per call, batch size, time in a queue.
 *
 * Percentiles come back with it, which is the point — an average cost per LLM
 * call hides the one prompt that cost fifty times the rest.
 */
export declare function histogram(name: string, value: number, labels?: MetricLabels, unit?: string): void;
/** Grouped access, for callers who prefer one import. */
export declare const metric: {
    count: typeof count;
    gauge: typeof gauge;
    histogram: typeof histogram;
};
