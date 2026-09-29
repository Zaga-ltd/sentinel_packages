/** rrweb's event shape, kept structural so the SDK does not depend on its types. */
export interface ReplayEvent {
    type: number;
    timestamp: number;
    data?: unknown;
}
export interface ReplayOptions {
    enabled?: boolean;
    /** Seconds of history kept in memory. The window you get before an error. */
    bufferSeconds?: number;
    /** Seconds to keep recording *after* the error that triggered the upload. */
    tailSeconds?: number;
    /** Ceiling on the buffer, whatever `bufferSeconds` would allow. */
    maxBufferBytes?: number;
    /**
     * Fraction of sessions recorded even without an error, 0..1.
     *
     * Defaults to 0 — errors only. Raise it to catch UX problems that never
     * throw, and expect storage to grow in proportion.
     */
    sessionSampleRate?: number;
    /**
     * Elements whose text should be readable. Everything else is masked.
     *
     * The default posture is that nothing is legible: replay shows layout,
     * clicks and navigation, and text renders as blocks. Nobody enables replay
     * expecting to ship customer names and order details to a vendor, so opting
     * *in* to visibility is the only safe direction for this switch to point.
     */
    unmaskSelector?: string;
    /** Elements omitted entirely — not even their layout is recorded. */
    blockSelector?: string;
    /**
     * Supply rrweb yourself instead of letting the SDK import it.
     *
     * For bundlers that cannot resolve a dynamic import, and for apps that
     * already ship rrweb and do not want a second copy.
     */
    recorder?: {
        record: (...args: any[]) => (() => void) | undefined;
    };
    /** Console noise about what the recorder is doing. */
    debug?: boolean;
}
export interface ReplayUpload {
    replayId: string;
    sessionId?: string;
    /** Who was using the app. Resolved at upload time, not at start. */
    consumerIdentifier?: string;
    seq: number;
    events: ReplayEvent[];
    startedAt: string;
    durationMs: number;
    url?: string;
    trigger: "error" | "sampled";
    errorId?: string;
}
export interface ReplayController {
    /** Upload the buffer because this error happened. */
    onError(errorId?: string): void;
    /** Stop recording and release the buffer. */
    stop(): void;
    /** Flush anything pending — used on page unload. */
    flush(): void;
    readonly replayId: string;
    readonly recording: boolean;
}
/**
 * Start recording.
 *
 * `send` is called with each chunk. It is given whole chunks rather than raw
 * events so the transport can decide about `sendBeacon` vs `fetch` without
 * knowing anything about rrweb.
 */
export declare function startReplay(options: ReplayOptions, send: (upload: ReplayUpload) => void, getSessionId?: () => string | undefined, 
/**
 * Read at upload time rather than captured at start: identify() usually runs
 * after the recorder does, so asking early would attribute every recording
 * to nobody.
 */
getConsumer?: () => string | undefined): Promise<ReplayController | null>;
/** Exported for the tests, which assert the snapshot-preserving trim rule. */
export declare const __testing: {
    FULL_SNAPSHOT: number;
    META: number;
    DEFAULTS: {
        bufferSeconds: number;
        tailSeconds: number;
        maxBufferBytes: number;
        sessionSampleRate: number;
        unmaskSelector: string;
        blockSelector: string;
    };
};
