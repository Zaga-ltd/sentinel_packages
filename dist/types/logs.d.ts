export type LogLevel = "debug" | "info" | "warn" | "error";
export interface CapturedLog {
    timestamp: string;
    level: LogLevel;
    message: string;
    requestId?: string;
    /** Position within the request — keeps same-millisecond lines ordered. */
    seq?: number;
}
export interface LogCaptureOptions {
    /** Enable console capture during request handling (default: false). */
    enabled: boolean;
    /** Minimum level to capture (default: "info"; "debug" captures everything). */
    minLevel?: LogLevel;
    /** Cap per request so a hot loop can't flood the buffer (default: 50). */
    maxPerRequest?: number;
    /** Truncate individual messages to this many chars (default: 2000). */
    maxMessageLength?: number;
}
interface RequestLogContext {
    requestId: string;
    buffer: CapturedLog[];
    dropped: number;
}
/** Patch console once. Idempotent; original behaviour is preserved. */
export declare function instrumentConsole(options: LogCaptureOptions): void;
/** One request's captured console lines, held by reference. */
export type RequestLogContextHandle = RequestLogContext;
/** Called from the plugin's derive hook: opens this request's log context. */
export declare function beginRequestLogContext(requestId: string): RequestLogContextHandle;
/** A context not yet entered — pair with runWithRequestLogContext(). */
export declare function createRequestLogContext(requestId: string): RequestLogContextHandle;
/** Enter an existing context for the rest of this async execution. */
export declare function enterRequestLogContext(ctx: RequestLogContextHandle): void;
export declare function runWithRequestLogContext<T>(ctx: RequestLogContextHandle, fn: () => T): T;
/** Called from afterResponse: drains and returns this request's lines. */
export declare function drainRequestLogs(ctx?: RequestLogContextHandle | undefined): {
    logs: CapturedLog[];
    dropped: number;
};
export {};
