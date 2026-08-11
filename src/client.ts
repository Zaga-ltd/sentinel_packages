// ─── Who called, and from where ─────────────────────────────────────────────
//
// Resolved in the plugin rather than at the API, because by the time a payload
// reaches Sentrinel the only address left is the customer's own server. The
// caller's address exists only inside their process.

/**
 * Headers that carry the original client address, most-specific first.
 *
 * Order matters: a request through Cloudflare has both CF-Connecting-IP and
 * X-Forwarded-For, and the former is the one Cloudflare vouches for. XFF is
 * last because it is the easiest to spoof and the messiest to parse.
 */
const IP_HEADERS = [
  "cf-connecting-ip", // Cloudflare
  "true-client-ip", // Akamai, Cloudflare Enterprise
  "x-real-ip", // nginx
  "fly-client-ip", // Fly.io
  "x-client-ip",
  "x-forwarded-for", // the general case, may be a list
];

/**
 * Country headers set by the edge that terminated TLS.
 *
 * Taking the country from a header rather than resolving the IP is deliberate:
 * a GeoIP database is a licensing question and tens of megabytes of memory in
 * every customer process, and the edge already did the lookup more accurately
 * than we could. When there is no edge, there is no country — which is honest,
 * and better than a wrong guess.
 */
const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "x-geo-country",
  "fastly-client-country-code",
  "cloudfront-viewer-country", // AWS CloudFront
];

/** ISO-3166 alpha-2, or nothing. "XX" is Cloudflare's "unknown". */
export function clientCountry(headers: Headers): string | undefined {
  for (const h of COUNTRY_HEADERS) {
    const v = headers.get(h);
    if (!v) continue;
    const code = v.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1") return code;
  }
  return undefined;
}

/**
 * The caller's address.
 *
 * X-Forwarded-For is a chain — `client, proxy1, proxy2` — and the leftmost
 * entry is the original client. Everything after it was appended by a hop.
 */
export function clientIp(headers: Headers): string | undefined {
  for (const h of IP_HEADERS) {
    const raw = headers.get(h);
    if (!raw) continue;
    const first = raw.split(",")[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  return undefined;
}

/**
 * The host the client addressed, which is not always the one we think we are.
 *
 * No `:authority` fallback: `Headers.get` throws on a pseudo-header name, and
 * HTTP/2 servers already surface `:authority` as `host` by the time a Request
 * exists — so reaching for it is both illegal and pointless.
 */
export function requestHost(headers: Headers): string | undefined {
  const h = headers.get("host");
  return h ? h.trim().slice(0, 255) : undefined;
}
