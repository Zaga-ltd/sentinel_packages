// ─── Collapsing identifiers out of a route path ─────────────────────────────
//
// The same rules the API applies at ingest, applied here first so they never
// have to be applied to a batch that was already rejected.
//
// The collector aggregates in memory keyed on `METHOD:route`, and the route is
// the framework's matched route where there is one and the raw URL where there
// is not — static files, 404s, anything served without a route entry. With raw
// URLs that map grows one entry per request between flushes, and the API
// refuses a metrics batch carrying more than 2,000 endpoints with a 413. The
// whole flush is lost, silently, for exactly the apps with the most traffic.
//
// Measured on production data: 443,012 distinct paths across eight apps become
// 828 routes, and no real route is collapsed.
//
// Kept in step with apps/api/src/lib/route-path.ts by
// apps/api/tests/route-path.test.ts, which runs both over the same cases. This
// package publishes standalone and cannot import from the API, so the code is
// duplicated on purpose — the test is what stops the two drifting.

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC = /^\d+$/;
const HEX = /^[0-9a-fA-F]{16,}$/;
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const PREFIXED = /^([A-Za-z][A-Za-z_]*)-(.+)$/;
const FILENAME = /^(.+)\.([A-Za-z0-9]{1,5})$/;

/**
 * Does this look like an identifier rather than a word?
 *
 * Telling `merchant-8f5v2Q2SkT` from `call-histories` is the whole difficulty,
 * and length cannot do it — both are long and hyphenated. An identifier carries
 * entropy a word does not: a digit, or a change of case mid-token. Collapsing
 * a real route merges two endpoints into one and cannot be undone, so the bar
 * is high and the default is to leave a segment alone.
 */
function looksLikeId(s: string): boolean {
  if (s.length < 8) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  return /\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
}

function normaliseSegment(segment: string): string {
  if (UUID.test(segment)) return "{uuid}";
  if (NUMERIC.test(segment)) return "{id}";
  if (HEX.test(segment)) return "{hash}";
  if (DATE.test(segment)) return "{date}";

  const prefixed = PREFIXED.exec(segment);
  if (prefixed && looksLikeId(prefixed[2])) return "{id}";

  if (segment.length >= 10 && /^[A-Za-z0-9]+$/.test(segment) && looksLikeId(segment)) {
    return "{id}";
  }

  const file = FILENAME.exec(segment);
  if (file) {
    const stem = normaliseSegment(file[1]);
    if (stem !== file[1]) return `${stem}.${file[2]}`;
  }

  return segment;
}

/**
 * The route identity for a path. Idempotent, and a no-op on a route the
 * framework already parameterised (`/orders/:id`, `/orders/{id}`).
 */
export function normaliseRoutePath(path: string | null | undefined): string {
  if (!path) return "";
  const clean = path.split("?")[0].split("#")[0];
  if (!clean.includes("/")) return normaliseSegment(clean);
  return clean
    .split("/")
    .map((s) => (s ? normaliseSegment(s) : s))
    .join("/");
}
