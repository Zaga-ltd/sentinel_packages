// ─── The key updates are signed with ─────────────────────────────────────────
//
// The manifest at https://sentrinel.dev/mcp-version.json names a sha256 for
// each bundle, but it comes from the same place as the bundles: whoever can
// change one can change both, and a checksum then proves nothing but that the
// download was not truncated. The signature is what ties an update to the
// people who publish it — the private half never touches the site, it only
// exists where the site is built (SENTRINEL_UPDATE_SIGNING_KEY, read by
// apps/web/build.ts), so a compromised CDN or Pages project cannot mint a
// manifest this copy will accept.
//
// The raw 32-byte ed25519 public key, base64. `bun packages/mcp/scripts/gen-update-key.ts`
// prints a fresh pair: this value, and the one for SENTRINEL_UPDATE_SIGNING_KEY.
//
// While it is the placeholder, nothing is ever applied automatically and
// `sentrinel update` says why — an updater with no key to check against is
// exactly the unauthenticated code path this file exists to close.

export const UPDATE_KEY_PLACEHOLDER = "REPLACE_WITH_PUBLIC_KEY_BASE64";

export const UPDATE_PUBLIC_KEY: string = "9tO1qnmqKUEUll08z3t2zzn8Ynl8jLkoon6uU8ha8s0=";
