// ─── Signing the update manifest ─────────────────────────────────────────────
//
// One module for both halves, so the bytes the build signs and the bytes the
// updater checks cannot be computed two different ways. apps/web/build.ts signs
// with the private key; update.ts verifies with UPDATE_PUBLIC_KEY; install.sh
// carries a copy of manifestPayload() (Bun is installed by then) and a test
// runs that copy against a manifest signed here, so the three stay in step.
//
// What is signed is a canonical text form of the version and the per-file
// sha256s — not the JSON as served. JSON has no single byte form (key order,
// whitespace), and those two fields are the whole of what the updater acts on:
// the version decides whether to update, the hashes decide what is installed.

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

import { UPDATE_KEY_PLACEHOLDER, UPDATE_PUBLIC_KEY } from "./update-key";

export interface SignedFields {
  version: string;
  files: Record<string, string>;
}

/**
 * The exact bytes behind the signature, or null for a manifest that could not
 * have been signed honestly.
 *
 * Names and hashes are held to a strict alphabet because the form is
 * line-based: a file name carrying a newline could otherwise forge a second
 * `file` line that the signer never saw.
 */
export function manifestPayload(m: SignedFields): string | null {
  if (!m || typeof m.version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return null;
  if (!m.files || typeof m.files !== "object") return null;
  const lines = ["sentrinel-mcp-manifest v1", `version ${m.version}`];
  for (const name of Object.keys(m.files).sort()) {
    const hash = m.files[name];
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      return null;
    }
    lines.push(`file ${name} ${hash}`);
  }
  return lines.join("\n") + "\n";
}

// An ed25519 SubjectPublicKeyInfo is this fixed 12-byte header and the raw
// 32-byte key, which is what lets the constant stay a short base64 string.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function hasPublicKey(publicKey: string = UPDATE_PUBLIC_KEY): boolean {
  return publicKeyFrom(publicKey) !== null;
}

function publicKeyFrom(b64: string): KeyObject | null {
  if (!b64 || b64 === UPDATE_KEY_PLACEHOLDER) return null;
  try {
    const raw = Buffer.from(b64, "base64");
    if (raw.length !== 32) return null;
    const der = new Uint8Array([...SPKI_ED25519_PREFIX, ...raw]);
    return createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/**
 * SENTRINEL_UPDATE_SIGNING_KEY: an ed25519 private key as base64 PKCS#8 DER on
 * one line (what `openssl genpkey -algorithm ed25519 -outform DER | base64`
 * and scripts/gen-update-key.ts print). A PEM block is accepted too, for
 * anyone who pastes the file as it came.
 */
export function privateKeyFrom(value: string): KeyObject {
  const v = value.trim();
  const key = v.includes("-----BEGIN")
    ? createPrivateKey(v)
    : createPrivateKey({ key: Buffer.from(v, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the signing key is ${key.asymmetricKeyType}, not ed25519`);
  }
  return key;
}

/** The base64 raw public key belonging to a private one — the UPDATE_PUBLIC_KEY value. */
export function publicKeyOf(privateKey: string): string {
  const spki = createPublicKey(privateKeyFrom(privateKey)).export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(SPKI_ED25519_PREFIX.length).toString("base64");
}

export function signManifest(m: SignedFields, privateKey: string): string {
  const payload = manifestPayload(m);
  if (!payload) throw new Error("the manifest has a malformed version or file entry");
  return sign(null, new TextEncoder().encode(payload), privateKeyFrom(privateKey)).toString("base64");
}

/**
 * install.sh with its UPDATE_PUBLIC_KEY line set to `publicKey`, for the
 * build to publish. The key lives in one place (update-key.ts) and the script
 * in the repository keeps the placeholder. Null when the line is missing, so
 * the build can say so instead of publishing an installer that checks nothing.
 */
export function withPublicKey(installSh: string, publicKey: string): string | null {
  const line = /^UPDATE_PUBLIC_KEY="[^"\n]*"$/m;
  if (!line.test(installSh) || !/^[A-Za-z0-9+/=_-]+$/.test(publicKey)) return null;
  return installSh.replace(line, `UPDATE_PUBLIC_KEY="${publicKey}"`);
}

/**
 *   valid    — signed by the key this copy trusts
 *   no-key   — this copy was built without one, so nothing can be trusted
 *   unsigned — the manifest carries no signature
 *   invalid  — it carries one, and it is wrong
 */
export type Verdict = "valid" | "no-key" | "unsigned" | "invalid";

export function verifyManifest(
  m: SignedFields & { signature?: unknown },
  publicKey: string = UPDATE_PUBLIC_KEY
): Verdict {
  const key = publicKeyFrom(publicKey);
  if (!key) return "no-key";
  if (typeof m.signature !== "string" || !m.signature) return "unsigned";
  const payload = manifestPayload(m);
  if (!payload) return "invalid";
  try {
    const signature = new Uint8Array(Buffer.from(m.signature, "base64"));
    return verify(null, new TextEncoder().encode(payload), key, signature) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}
