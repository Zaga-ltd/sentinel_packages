import type { CapturedBody } from "./core.js";
export interface NodeResponseLike {
    statusCode?: number;
    headersSent?: boolean;
    writableFinished?: boolean;
    getHeader(name: string): unknown;
    end: (...args: any[]) => any;
    write: (...args: any[]) => any;
    once(event: string, listener: (...args: any[]) => void): unknown;
}
export declare function headerString(value: unknown): string | null;
export interface ResponseCapture {
    /** Bytes written, whether captured or not. */
    written(): number;
    body(): CapturedBody | undefined;
}
/**
 * Patch `write`/`end` to observe what is sent. Must be called before the
 * handler writes anything.
 */
export declare function captureNodeResponse(res: NodeResponseLike, opts: {
    logBody: boolean;
    maxBodySize: number;
}): ResponseCapture;
/**
 * Call `record` once, when the response finishes — or when the client hangs
 * up first, with `aborted` set.
 */
export declare function onResponseDone(res: NodeResponseLike, record: (aborted: boolean) => void): void;
