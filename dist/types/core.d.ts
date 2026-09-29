import { MetricsCollector } from "./collector.js";
import { type TraceContext } from "./tracer.js";
import { type RequestLogContextHandle } from "./logs.js";
import { type CanonicalScope } from "./logger.js";
import { type ConsumerIdentity, type SentrinelPluginOptions } from "./types.js";
/** Who the browser SDK says is calling — `guest:<device>` or the identified user. */
export declare const CONSUMER_HEADER = "x-sentrinel-consumer";
/** The browser's persisted anonymous id. */
export declare const DEVICE_HEADER = "x-sentrinel-device";
/** Read one request header by lower-case name. */
export type HeaderGetter = (name: string) => string | null | undefined;
export interface RequestState {
    requestLogId: string;
    startPerf: number;
    startISO: string;
    method: string;
    url: URL;
    trace: TraceContext;
    canonical: CanonicalScope;
    logCtx?: RequestLogContextHandle;
    /** A trusted `x-sentrinel-consumer`, used only when the resolver finds nobody. */
    headerConsumer?: string;
    /** `x-sentrinel-device`, recorded as the `device.id` attribute. */
    deviceId?: string;
    origin: {
        clientIp?: string;
        country?: string;
        host?: string;
    };
}
/** A body as the adapter found it: text it read, or a value the framework parsed. */
export interface CapturedBody {
    text?: string;
    value?: unknown;
    /** Capture stopped at the byte limit. */
    truncated?: boolean;
    /** The full size, when known (content-length). */
    totalBytes?: number;
    contentType?: string | null;
}
export interface RequestOutcome {
    statusCode: number;
    /** The matched route pattern. Falls back to the path, which the collector normalises. */
    route?: string;
    /** A thrown error — the only source of a real stack trace. */
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
    /** Whatever `consumerIdentifier` resolved to. */
    consumer?: string | ConsumerIdentity | null;
    requestSize?: number;
    responseSize?: number;
    /** Called only when headers are being logged. */
    requestHeaders?: () => Record<string, string>;
    requestBody?: CapturedBody;
    responseBody?: CapturedBody;
}
export interface ServerInstrumentation {
    readonly collector: MetricsCollector;
    readonly options: SentrinelPluginOptions;
    /** Byte limit for body capture. */
    readonly maxBodySize: number;
    isExcludedPath(pathname: string): boolean;
    begin(method: string, url: URL, header: HeaderGetter): RequestState;
    /** Run `fn` inside the request's scopes; they end when it does. */
    run<T>(state: RequestState, fn: () => T): T;
    /** Enter the request's scopes for the rest of this async execution (Elysia's hooks). */
    enter(state: RequestState): void;
    /** Resolve the configured consumer from a header-name shorthand. */
    consumerFromHeader(header: HeaderGetter): string | null | undefined;
    finish(state: RequestState, outcome: RequestOutcome): void;
    flush(): Promise<void>;
    stop(): Promise<void>;
}
/**
 * Validate `x-sentrinel-consumer`.
 *
 * A header a browser sets is a claim, so it is only ever a fallback for a
 * request the app's own resolver could not attribute, and only in a shape that
 * impersonates nobody: `guest:<device id>`, or whatever the app explicitly
 * trusts through `consumerHeaderPattern`.
 */
export declare function trustedHeaderConsumer(value: string | null | undefined, pattern?: RegExp): string | undefined;
export declare function trustedDeviceId(value: string | null | undefined): string | undefined;
export declare function getStatusMessage(code: number): string;
/** A status set as a name (`set.status = "Not Found"`), back to its number. */
export declare function statusFromName(name: string): number | undefined;
export declare function errorShape(err: unknown): {
    name: string;
    message: string;
    stack?: string;
} | undefined;
export declare function createServerInstrumentation(options: SentrinelPluginOptions, adapter: string): ServerInstrumentation;
/** Node-style headers (`IncomingMessage.headers`) as a flat string map. */
export declare function flattenNodeHeaders(headers: Record<string, string | string[] | number | undefined>): Record<string, string>;
/** A header getter over Node-style headers. */
export declare function nodeHeaderGetter(headers: Record<string, string | string[] | number | undefined>): HeaderGetter;
