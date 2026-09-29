"use strict";
// ─── Data Masking Utilities ──────────────────────────────────────────────────────
//
// Masking runs in the customer's process, before anything leaves it. The rules
// that matter:
//
//   1. **A built-in deny-list always applies.** It used to apply only when the
//      caller passed patterns of their own, so the default configuration —
//      `logRequestHeaders: true` and nothing else — shipped every
//      `Authorization` header and session cookie verbatim. User patterns are
//      added to the defaults, never a replacement for them.
//
//   2. **Names are matched, not values.** A pattern says "the field called
//      password", never "anything that looks like a card number" — value
//      heuristics mangle ids and miss the secrets that matter.
//
//   3. **A body that does not parse still gets masked.** Bodies are captured
//      up to a byte cap, so a large JSON payload arrives truncated and no longer
//      parses. Falling back to "send it as-is" would ship exactly the passwords
//      the parse was supposed to find, so there is a text-level fallback.
//
// No imports: the browser SDK uses this module too, and must not pull anything
// node-only into a page bundle.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MASK_VALUE = void 0;
exports.shouldMaskHeader = shouldMaskHeader;
exports.shouldMaskField = shouldMaskField;
exports.shouldMaskQueryKey = shouldMaskQueryKey;
exports.maskQueryParams = maskQueryParams;
exports.maskHeaders = maskHeaders;
exports.maskBodyFields = maskBodyFields;
exports.maskUrl = maskUrl;
exports.truncateBody = truncateBody;
exports.MASK_VALUE = "***";
/**
 * Field names reduced to their letters and digits, lower-cased.
 *
 * `access_token`, `accessToken`, `access-token` and `X-Access-Token` are the
 * same secret spelled four ways; comparing a normal form catches all of them
 * with one rule instead of four regexes that each miss a spelling.
 */
function normalise(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/** Anything whose name *contains* one of these is a secret. */
const SECRET_FRAGMENTS = [
    "password",
    "passwd",
    "secret",
    "apikey",
    "authorization",
    "creditcard",
    "cardnumber",
    "ccnumber",
    "cvv",
    "cvc",
    "privatekey",
    "credential",
];
/**
 * …and anything whose name *ends* with one of these.
 *
 * Suffix, not substring, for `token`: `accessToken` and `csrf_token` are
 * secrets, `tokenCount` and `tokens_used` (an LLM bill) are not.
 */
const SECRET_SUFFIXES = ["token", "signature"];
/** Exact names that are secrets on their own but too short to use as fragments. */
const SECRET_EXACT_BODY = new Set(["pwd", "pin", "ssn", "otp"]);
function isDefaultSecretName(name) {
    const n = normalise(name);
    if (!n)
        return false;
    if (SECRET_EXACT_BODY.has(n))
        return true;
    if (SECRET_SUFFIXES.some((s) => n.endsWith(s)))
        return true;
    return SECRET_FRAGMENTS.some((f) => n.includes(f));
}
/**
 * Headers that carry credentials. Exact names first — these are the ones a
 * default configuration used to send in the clear — then the same name rules
 * as bodies, which catch `x-amz-security-token`, `x-csrf-token` and friends.
 */
const SECRET_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
]);
function isDefaultSecretHeader(name) {
    return SECRET_HEADERS.has(name.toLowerCase()) || isDefaultSecretName(name);
}
/**
 * Query keys that carry credentials: password-reset and magic-link tokens, the
 * OAuth `code`, pre-signed S3/GCS URLs, `?api_key=`.
 *
 * `code` and `key` are masked although they are sometimes harmless — a promo
 * code, a sort key. The cost of masking a promo code is a `***` in a log row;
 * the cost of not masking an OAuth code is a replayable login.
 */
const SECRET_QUERY_EXACT = new Set([
    "token",
    "key",
    "apikey",
    "code",
    "password",
    "signature",
    "sig",
    "secret",
    "auth",
    "session",
    "sessionid",
    "jwt",
]);
function isDefaultSecretQueryKey(name) {
    const n = normalise(name);
    return SECRET_QUERY_EXACT.has(n) || isDefaultSecretName(name);
}
/** Check if a field name matches any of the provided patterns. */
function matchesPattern(fieldName, patterns) {
    if (!patterns)
        return false;
    for (const pattern of patterns) {
        if (typeof pattern === "string") {
            if (fieldName.toLowerCase() === pattern.toLowerCase())
                return true;
        }
        else if (pattern instanceof RegExp) {
            // A /g regex keeps state between .test() calls, so the same key would
            // alternate between matching and not. Reset it rather than trusting the
            // caller never to pass one.
            pattern.lastIndex = 0;
            if (pattern.test(fieldName))
                return true;
        }
    }
    return false;
}
function shouldMaskHeader(name, patterns) {
    return isDefaultSecretHeader(name) || matchesPattern(name, patterns);
}
function shouldMaskField(name, patterns) {
    return isDefaultSecretName(name) || matchesPattern(name, patterns);
}
function shouldMaskQueryKey(name, patterns) {
    return isDefaultSecretQueryKey(name) || matchesPattern(name, patterns);
}
/**
 * Mask query parameters. The built-in list always applies; `patterns` adds to
 * it.
 */
function maskQueryParams(params, patterns) {
    if (!params)
        return undefined;
    const masked = {};
    for (const [key, value] of Object.entries(params)) {
        masked[key] = shouldMaskQueryKey(key, patterns) ? exports.MASK_VALUE : value;
    }
    return masked;
}
/** Mask headers. The built-in list always applies; `patterns` adds to it. */
function maskHeaders(headers, patterns) {
    if (!headers)
        return undefined;
    const masked = {};
    for (const [key, value] of Object.entries(headers)) {
        masked[key] = shouldMaskHeader(key, patterns) ? exports.MASK_VALUE : value;
    }
    return masked;
}
/**
 * Mask sensitive fields in a body.
 *
 * Accepts a parsed object or the raw text. Text is handled as JSON when it
 * parses, as `application/x-www-form-urlencoded` or multipart when it looks
 * like one, and otherwise by a JSON-shaped text scan — see the header of this
 * file for why "it did not parse" must never mean "send it unmasked".
 *
 * The built-in list always applies; `patterns` adds to it.
 */
function maskBodyFields(body, patterns, contentType) {
    if (body === null || body === undefined || body === "")
        return body;
    if (typeof body === "string")
        return maskBodyText(body, patterns, contentType);
    if (typeof body === "object") {
        return maskObjectFields(body, patterns, 0);
    }
    return body;
}
function maskBodyText(text, patterns, contentType) {
    const type = (contentType ?? "").toLowerCase();
    if (type.includes("multipart/form-data") || /^--[^\r\n]{1,200}\r?\ncontent-disposition:/i.test(text)) {
        return maskMultipart(text, patterns);
    }
    const trimmed = text.trimStart();
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (looksJson || type.includes("json")) {
        try {
            return JSON.stringify(maskObjectFields(JSON.parse(text), patterns, 0));
        }
        catch {
            // Truncated or malformed: mask what can be recognised in the text.
            return maskJsonLikeText(text, patterns);
        }
    }
    if (type.includes("x-www-form-urlencoded") || looksFormEncoded(trimmed)) {
        return maskFormEncoded(text, patterns);
    }
    // Unknown text. Still worth a scan: a JSON fragment inside a plain-text log
    // body is common enough, and the scan is a no-op when nothing matches.
    return maskJsonLikeText(text, patterns);
}
/** Recursively mask fields in an object. */
function maskObjectFields(obj, patterns, depth) {
    if (obj === null || obj === undefined)
        return obj;
    if (typeof obj !== "object")
        return obj;
    // A cyclic or absurdly deep structure must not take the request down.
    if (depth > 32)
        return "[depth limit]";
    if (Array.isArray(obj)) {
        return obj.map((item) => maskObjectFields(item, patterns, depth + 1));
    }
    const masked = {};
    for (const [key, value] of Object.entries(obj)) {
        if (shouldMaskField(key, patterns)) {
            masked[key] = exports.MASK_VALUE;
        }
        else if (typeof value === "object" && value !== null) {
            masked[key] = maskObjectFields(value, patterns, depth + 1);
        }
        else {
            masked[key] = value;
        }
    }
    return masked;
}
function looksFormEncoded(text) {
    // `a=1&b=2` with no whitespace or braces — a sentence or a stack trace does
    // not qualify, so this does not reinterpret arbitrary text.
    return /^[^\s=&{}[\]]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*&?$/.test(text.slice(0, 4096));
}
function maskFormEncoded(text, patterns) {
    // Rewritten pair by pair rather than through URLSearchParams, which would
    // re-encode every value and make the logged body differ from what was sent.
    return text
        .split("&")
        .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0)
            return pair;
        const rawKey = pair.slice(0, eq);
        let key = rawKey;
        try {
            key = decodeURIComponent(rawKey.replace(/\+/g, " "));
        }
        catch {
            // A malformed escape is still a key worth testing as written.
        }
        return shouldMaskField(key, patterns) ? `${rawKey}=${exports.MASK_VALUE}` : pair;
    })
        .join("&");
}
/**
 * Multipart bodies: mask the value of any part whose field name is sensitive.
 * File parts are never captured in the first place (see body.ts), so this only
 * ever sees text fields.
 */
function maskMultipart(text, patterns) {
    return text.replace(/(content-disposition:[^\r\n]*\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--|$)/gi, (whole, head, name) => (shouldMaskField(name, patterns) ? `${head}${exports.MASK_VALUE}` : whole));
}
/**
 * Mask `"key": value` pairs in text that is JSON-shaped but does not parse —
 * typically a body cut off at the capture limit. The value may itself be cut
 * off, which is why the closing quote is optional.
 */
function maskJsonLikeText(text, patterns) {
    return text.replace(/"((?:[^"\\\r\n]|\\.){1,200})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\]\s]+)/g, (whole, key, sep) => shouldMaskField(key, patterns) ? `"${key}"${sep}"${exports.MASK_VALUE}"` : whole);
}
/**
 * Mask the sensitive query (and fragment) parameters of a URL, leaving the
 * rest exactly as written.
 *
 * The fragment is included because OAuth's implicit flow returns
 * `#access_token=…`, and a single-page app's `location.href` carries it until
 * the router rewrites it. Works on absolute and relative URLs alike, and on
 * strings that are not URLs at all (returned unchanged).
 */
function maskUrl(url, patterns) {
    if (!url || (url.indexOf("?") < 0 && url.indexOf("#") < 0))
        return url;
    const hashAt = url.indexOf("#");
    const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const hash = hashAt >= 0 ? url.slice(hashAt + 1) : undefined;
    const queryAt = beforeHash.indexOf("?");
    const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
    const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : undefined;
    let out = base;
    if (query !== undefined)
        out += `?${maskParamString(query, patterns)}`;
    if (hash !== undefined) {
        // A route fragment (`#/orders/1`) is not a parameter list; only rewrite
        // one that looks like `a=b&c=d`.
        out += `#${hash.includes("=") ? maskParamString(hash, patterns) : hash}`;
    }
    return out;
}
function maskParamString(params, patterns) {
    return params
        .split("&")
        .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0)
            return pair;
        const rawKey = pair.slice(0, eq);
        let key = rawKey;
        try {
            key = decodeURIComponent(rawKey.replace(/\+/g, " "));
        }
        catch {
            // Malformed escape: test the key as written.
        }
        return shouldMaskQueryKey(key, patterns) ? `${rawKey}=${exports.MASK_VALUE}` : pair;
    })
        .join("&");
}
/**
 * Truncate a body string to the maximum allowed size.
 *
 * `totalBytes` is the real size when the caller knows it (a content-length, or
 * a capture that stopped early); without it the marker says only that the
 * body was cut.
 */
function truncateBody(body, maxSize = 10000, totalBytes) {
    if (!body)
        return undefined;
    if (body.length <= maxSize)
        return body;
    const total = totalBytes ?? body.length;
    return body.slice(0, maxSize) + `... [truncated, ${total} bytes total]`;
}
