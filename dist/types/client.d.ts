/** ISO-3166 alpha-2, or nothing. "XX" is Cloudflare's "unknown". */
export declare function clientCountry(headers: Headers): string | undefined;
/**
 * The caller's address.
 *
 * X-Forwarded-For is a chain — `client, proxy1, proxy2` — and the leftmost
 * entry is the original client. Everything after it was appended by a hop.
 */
export declare function clientIp(headers: Headers): string | undefined;
/**
 * The host the client addressed, which is not always the one we think we are.
 *
 * No `:authority` fallback: `Headers.get` throws on a pseudo-header name, and
 * HTTP/2 servers already surface `:authority` as `host` by the time a Request
 * exists — so reaching for it is both illegal and pointless.
 */
export declare function requestHost(headers: Headers): string | undefined;
