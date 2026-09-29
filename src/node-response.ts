// ─── Capturing a Node `ServerResponse` ───────────────────────────────────────
//
// Shared by Express and the Next.js Pages API wrapper, which both answer
// through a Node response object rather than returning a Response.
//
// The body is captured as it is written, up to a limit, and only when it will
// be used: logged bodies, or an error response whose message is worth having.
// Every byte is still counted, so the recorded size is real.

import { isCapturableBody } from "./body";
import type { CapturedBody } from "./core";

export interface NodeResponseLike {
  statusCode?: number;
  headersSent?: boolean;
  writableFinished?: boolean;
  getHeader(name: string): unknown;
  end: (...args: any[]) => any;
  write: (...args: any[]) => any;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

/** Captured for error messages when the body is not being logged. */
const ERROR_BODY_BYTES = 8 * 1024;

export function headerString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

function toBuffer(chunk: unknown, encoding?: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

export interface ResponseCapture {
  /** Bytes written, whether captured or not. */
  written(): number;
  body(): CapturedBody | undefined;
}

/**
 * Patch `write`/`end` to observe what is sent. Must be called before the
 * handler writes anything.
 */
export function captureNodeResponse(
  res: NodeResponseLike,
  opts: { logBody: boolean; maxBodySize: number }
): ResponseCapture {
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  let written = 0;

  const capture = (chunk: unknown, encoding?: unknown) => {
    const buf = toBuffer(chunk, encoding);
    if (!buf) return;
    written += buf.length;
    if (truncated) return;
    const status = res.statusCode ?? 200;
    if (!opts.logBody && status < 400) return;
    if (
      !isCapturableBody(
        headerString(res.getHeader("content-type")),
        headerString(res.getHeader("content-encoding"))
      )
    ) {
      return;
    }
    const limit = opts.logBody ? opts.maxBodySize : ERROR_BODY_BYTES;
    const room = limit - captured;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const piece = buf.length > room ? buf.subarray(0, room) : buf;
    // Copied: the caller may reuse its buffer after write() returns.
    chunks.push(new Uint8Array(piece));
    captured += piece.length;
    if (buf.length > room) truncated = true;
  };

  const originalWrite = res.write;
  const originalEnd = res.end;
  res.write = function (this: unknown, chunk?: any, encoding?: any, ...rest: any[]) {
    try {
      capture(chunk, encoding);
    } catch {}
    return originalWrite.call(this, chunk, encoding, ...rest);
  };
  res.end = function (this: unknown, chunk?: any, encoding?: any, ...rest: any[]) {
    try {
      capture(chunk, encoding);
    } catch {}
    return originalEnd.call(this, chunk, encoding, ...rest);
  };

  return {
    written: () => written,
    body: () => {
      if (!chunks.length) return undefined;
      const declared = parseInt(headerString(res.getHeader("content-length")) || "0", 10) || 0;
      return {
        text: decodeChunks(chunks),
        truncated,
        totalBytes: truncated ? written || declared || undefined : undefined,
        contentType: headerString(res.getHeader("content-type")),
      };
    },
  };
}

/**
 * Call `record` once, when the response finishes — or when the client hangs
 * up first, with `aborted` set.
 */
export function onResponseDone(res: NodeResponseLike, record: (aborted: boolean) => void): void {
  let done = false;
  const once = (aborted: boolean) => {
    if (done) return;
    done = true;
    record(aborted);
  };
  res.once("finish", () => once(false));
  res.once("close", () => once(!res.writableFinished));
}
