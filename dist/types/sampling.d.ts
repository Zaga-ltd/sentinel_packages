import type { RequestLoggingOptions } from "./types.js";
export interface SampleDecision {
    capture: boolean;
    /** 1 for must-keep rows, the configured rate for sampled rows. */
    sampleRate: number;
}
export declare function shouldCaptureLog(statusCode: number, responseTimeMs: number, options: Pick<RequestLoggingOptions, "sampleRate" | "slowRequestThresholdMs">, random?: () => number): SampleDecision;
