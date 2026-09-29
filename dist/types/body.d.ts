/**
 * Is a body of this type worth capturing?
 *
 * A compressed body (`content-encoding: gzip`) is binary whatever its declared
 * type, so it is skipped too.
 */
export declare function isCapturableBody(contentType?: string | null, contentEncoding?: string | null): boolean;
export interface BoundedText {
    text: string;
    /** True when the stream had more than `maxBytes` and the rest was not read. */
    truncated: boolean;
    /** Bytes actually read (at most maxBytes + one chunk's overrun, trimmed). */
    bytes: number;
}
/**
 * Read at most `maxBytes` of a stream as UTF-8, then cancel it.
 *
 * Never throws: a stream that errors part-way returns what was read.
 */
export declare function readBoundedText(stream: ReadableStream<Uint8Array> | null | undefined, maxBytes: number): Promise<BoundedText | undefined>;
/**
 * Read the start of a request or response body without disturbing it.
 *
 * Works on a clone, so the original's stream is still unread for whoever owns
 * it. Returns undefined for bodiless messages, uncapturable types, and
 * anything that cannot be cloned (a body already consumed).
 */
export declare function peekBody(message: Request | Response, maxBytes: number): Promise<BoundedText | undefined>;
