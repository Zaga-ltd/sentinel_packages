"use strict";
// ─── Bounded body capture ────────────────────────────────────────────────────
//
// Logging a payload used to mean `await request.clone().text()` — reading the
// whole body into memory, then truncating it to `maxBodySize`. For a 200MB
// upload that is 200MB held twice (the clone tees the stream) to keep 64KB of
// it, on every request, whether or not the row was going to be sampled out.
//
// This reads at most `maxBytes` and cancels the rest. Cancelling one branch of
// a tee leaves the other untouched, so the handler still gets every byte.
//
// Some bodies are never worth reading at all: files, media, archives and
// streams. A multipart upload is mostly file bytes; an event stream never ends,
// and reading a clone of it would hold a copy of every event for the life of
// the connection.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCapturableBody = isCapturableBody;
exports.readBoundedText = readBoundedText;
exports.peekBody = peekBody;
/** Content types whose bodies are skipped outright. */
const UNCAPTURABLE = [
    "multipart/",
    "application/octet-stream",
    "image/",
    "audio/",
    "video/",
    "font/",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-protobuf",
    "application/protobuf",
    "application/grpc",
    "text/event-stream",
    "application/x-ndjson",
];
/**
 * Is a body of this type worth capturing?
 *
 * A compressed body (`content-encoding: gzip`) is binary whatever its declared
 * type, so it is skipped too.
 */
function isCapturableBody(contentType, contentEncoding) {
    if (contentEncoding && !/^\s*(identity)?\s*$/i.test(contentEncoding))
        return false;
    if (!contentType)
        return true;
    const type = contentType.toLowerCase();
    return !UNCAPTURABLE.some((prefix) => type.startsWith(prefix) || type.includes(prefix));
}
/**
 * Read at most `maxBytes` of a stream as UTF-8, then cancel it.
 *
 * Never throws: a stream that errors part-way returns what was read.
 */
async function readBoundedText(stream, maxBytes) {
    if (!stream)
        return undefined;
    const limit = Math.max(0, maxBytes);
    let reader;
    try {
        reader = stream.getReader();
    }
    catch {
        // Locked or already consumed.
        return undefined;
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            const chunk = typeof value === "string" ? new TextEncoder().encode(value) : value;
            if (bytes + chunk.byteLength > limit) {
                const room = limit - bytes;
                if (room > 0)
                    chunks.push(chunk.subarray(0, room));
                bytes += Math.max(0, room);
                truncated = true;
                break;
            }
            chunks.push(chunk);
            bytes += chunk.byteLength;
        }
    }
    catch {
        // Keep what arrived before the error.
    }
    finally {
        if (truncated) {
            // Stop pulling: the rest belongs to the other branch of the tee.
            reader.cancel().catch(() => { });
        }
        else {
            try {
                reader.releaseLock();
            }
            catch {
                // A released or errored reader has nothing left to release.
            }
        }
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
        joined.set(c, offset);
        offset += c.byteLength;
    }
    // `stream: true` would hold back a split multi-byte character; at a
    // truncation point a replacement character is the honest rendering.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
    return { text, truncated, bytes };
}
/**
 * Read the start of a request or response body without disturbing it.
 *
 * Works on a clone, so the original's stream is still unread for whoever owns
 * it. Returns undefined for bodiless messages, uncapturable types, and
 * anything that cannot be cloned (a body already consumed).
 */
async function peekBody(message, maxBytes) {
    try {
        if (!message.body)
            return undefined;
        if (message.bodyUsed)
            return undefined;
        if (!isCapturableBody(message.headers.get("content-type"), message.headers.get("content-encoding"))) {
            return undefined;
        }
        return await readBoundedText(message.clone().body, maxBytes);
    }
    catch {
        return undefined;
    }
}
