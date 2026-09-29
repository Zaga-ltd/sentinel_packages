// ─── Keeping the installed copy current ──────────────────────────────────────
//
// The CLI and MCP server are two bundled files under ~/.sentrinel. They are
// installed by piping a script to bash, which means the natural way to upgrade
// is to find that command again — so people don't, and run a months-old copy
// against a moving API. The database collector already had `update` for this
// reason; this is the same idea for the agent tooling.
//
// Two paths:
//
//   * `sentrinel update` — explicit, prints what changed.
//   * a check at most once a day, applied automatically unless turned off.
//
// What makes the automatic path acceptable is that it is not arbitrary code
// execution. The manifest is signed (ed25519, see signature.ts) by a key that
// never leaves the build, it names a sha256 for each bundle, the download must
// match it, and the replace is atomic. The checksum alone would only catch a
// truncated download — the manifest and bundles are served from the same
// place, so whoever could swap one could swap both — which is why a manifest
// that is unsigned, or signed by anyone else, is never applied. Nothing is
// fetched more than once a day, every failure is silent, and the whole thing
// is bounded by a short timeout — an update check must never be the reason a
// command is slow, fails, or an agent's server fails to start.

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, stat, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { VERSION } from "./version";
import { UPDATE_PUBLIC_KEY } from "./update-key";
import { hasPublicKey, verifyManifest } from "./signature";

export interface Manifest {
  version: string;
  files: Record<string, string>; // filename → sha256
  /** base64 ed25519 over signature.ts's manifestPayload(); absent when the build had no key. */
  signature?: string;
}

/** Where the installer puts things. Overridable for tests and odd setups. */
export function installDir(env: Record<string, string | undefined> = process.env): string {
  return env.SENTRINEL_HOME || join(homedir(), ".sentrinel");
}

export function baseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.SENTRINEL_INSTALL_BASE || "https://sentrinel.dev").replace(/\/+$/, "");
}

const BUNDLES = ["sentrinel-cli.js", "sentrinel-mcp.js"] as const;
const STAMP = ".last-update-check";

/** One check a day. A version is not worth a request per invocation. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const sha256 = (buf: Uint8Array) => createHash("sha256").update(new Uint8Array(buf)).digest("hex");

const reinstall = (base: string) => `curl -fsSL ${base}/install-mcp.sh | bash`;
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Compare two dotted versions.
 *
 * Only ever asked "is `latest` newer than what I am", so a non-numeric or
 * malformed part compares as 0 rather than throwing — a bad manifest must not
 * be able to crash a command that had nothing to do with updating.
 */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await work(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchManifest(
  opts: { base?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<Manifest | null> {
  const base = opts.base ?? baseUrl();
  const f = opts.fetchImpl ?? fetch;
  try {
    return await withTimeout(async (signal) => {
      const res = await f(`${base}/mcp-version.json`, { signal, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const body = (await res.json()) as Manifest;
      return body && typeof body.version === "string" && body.files ? body : null;
    }, opts.timeoutMs ?? 4000);
  } catch {
    // Offline, blocked, slow, or serving a web page instead of JSON. An update
    // check is never important enough to report as an error.
    return null;
  }
}

export interface UpdateResult {
  ok: boolean;
  from: string;
  to?: string;
  message: string;
  updated?: string[];
}

/**
 * Replace the installed bundles with the published ones.
 *
 * Downloads to uniquely named temporary files and renames, so an interrupted
 * or mismatched download never leaves half a bundle where a working one was,
 * and two processes updating at once (a CLI run and an agent's server) cannot
 * write into each other's file. Both files are fetched and verified *before*
 * either is moved, so the CLI and server cannot end up from different versions.
 *
 * Never throws: every failure, the filesystem refusing a write included, is a
 * result with a message.
 */
export async function applyUpdate(
  opts: {
    base?: string;
    dir?: string;
    manifest?: Manifest | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** The key the manifest must be signed with. Tests pass their own. */
    publicKey?: string;
  } = {}
): Promise<UpdateResult> {
  const base = opts.base ?? baseUrl();
  const dir = opts.dir ?? installDir();
  const f = opts.fetchImpl ?? fetch;

  const manifest = opts.manifest !== undefined ? opts.manifest : await fetchManifest({ base, fetchImpl: f });
  if (!manifest) {
    return { ok: false, from: VERSION, message: `Could not reach ${base} to check for updates.` };
  }
  if (!isNewer(manifest.version, VERSION)) {
    return { ok: true, from: VERSION, to: manifest.version, message: `Already current (${VERSION}).`, updated: [] };
  }
  const refused = (message: string): UpdateResult => ({ ok: false, from: VERSION, to: manifest.version, message });

  // Not an installed copy — running from a clone, or a moved directory. Saying
  // so beats writing bundles into a directory nothing will load them from.
  try {
    await stat(join(dir, BUNDLES[0]));
  } catch {
    return refused(
      `${manifest.version} is available, but this is not an installed copy ` +
        `(${dir} has no bundles). Re-run the installer to upgrade.`
    );
  }

  // Before anything is downloaded: a manifest nobody can vouch for names
  // checksums nobody can vouch for either.
  switch (verifyManifest(manifest, opts.publicKey ?? UPDATE_PUBLIC_KEY)) {
    case "valid":
      break;
    case "no-key":
      return refused(
        `${manifest.version} is available, but this copy was built without an update-signing key, so it ` +
          `cannot verify a download and will not install one. Upgrade with the installer:\n  ${reinstall(base)}`
      );
    case "unsigned":
      return refused(
        `${manifest.version} is available, but the published manifest is not signed, so it cannot be ` +
          `verified — nothing was changed. Upgrade with the installer:\n  ${reinstall(base)}`
      );
    case "invalid":
      // Loud on purpose, like a checksum mismatch: what arrived claims to be
      // a release and was not signed by whoever publishes them.
      return refused(
        `The manifest at ${base} does not carry a valid signature — nothing was changed. ` +
          "Something between you and the update server altered it, or Sentrinel did not publish it."
      );
  }

  const bodies: Array<[name: string, body: Uint8Array]> = [];
  for (const name of BUNDLES) {
    const expected = manifest.files[name];
    if (!expected) return refused(`The manifest does not list ${name}.`);
    let body: Uint8Array;
    try {
      body = await withTimeout(async (signal) => {
        const res = await f(`${base}/${name}`, { signal });
        if (!res.ok) throw new Error(`${name} returned ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      }, opts.timeoutMs ?? 30_000);
    } catch (err) {
      return refused(`Could not download ${name}: ${reason(err)}`);
    }
    if (sha256(body) !== expected) {
      // What arrived is not what was published. Could be a proxy serving a
      // login page, could be worse.
      return refused(`${name} did not match its published checksum — nothing was changed.`);
    }
    bodies.push([name, body]);
  }

  // Unique per process and per attempt: with one fixed name, two updates
  // running at once wrote into the same temporary file.
  const suffix = `.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  const staged: Array<[tmp: string, dest: string, name: string]> = [];
  const discard = () => Promise.all(staged.map(([tmp]) => rm(tmp, { force: true }).catch(() => {})));
  try {
    await mkdir(dir, { recursive: true });
    for (const [name, body] of bodies) {
      const tmp = join(dir, name + suffix);
      staged.push([tmp, join(dir, name), name]);
      await writeFile(tmp, body, { mode: 0o644 });
    }
  } catch (err) {
    await discard();
    return refused(`Could not write to ${dir}: ${reason(err)} — nothing was changed.`);
  }

  const moved: string[] = [];
  for (const [tmp, dest, name] of staged) {
    try {
      await rename(tmp, dest);
    } catch (err) {
      await discard();
      // Renames within one directory fail on the first file or not at all, in
      // practice. If one ever fails on the second, say exactly what state the
      // install is in rather than claiming nothing changed.
      return refused(
        moved.length
          ? `Updated ${moved.join(", ")} but could not replace ${name}: ${reason(err)}. ` +
              `Re-run the installer to put both on ${manifest.version}:\n  ${reinstall(base)}`
          : `Could not replace ${name}: ${reason(err)} — nothing was changed.`
      );
    }
    moved.push(name);
    await chmod(dest, 0o644).catch(() => {});
  }

  return {
    ok: true,
    from: VERSION,
    to: manifest.version,
    updated: BUNDLES.slice(),
    message: `Updated ${VERSION} → ${manifest.version}. Restart anything already running to pick it up.`,
  };
}

async function stampIsFresh(dir: string, now: number): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, STAMP), "utf8");
    const last = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(last) && now - last < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** False when the stamp could not be written — see autoUpdate for why that matters. */
async function writeStamp(dir: string, now: number): Promise<boolean> {
  try {
    await writeFile(join(dir, STAMP), String(now), { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The daily check, for callers that were doing something else.
 *
 * Returns a line worth showing, or null. Never throws — the caller has already
 * done what the user asked, and nothing here may turn that into a failure.
 * Writes the stamp *before* doing any work, so a hanging network cannot turn
 * into a check on every invocation.
 */
export async function autoUpdate(
  opts: {
    base?: string;
    dir?: string;
    env?: Record<string, string | undefined>;
    now?: number;
    fetchImpl?: typeof fetch;
    publicKey?: string;
  } = {}
): Promise<string | null> {
  try {
    const env = opts.env ?? process.env;
    if ((env.SENTRINEL_AUTO_UPDATE ?? "").toLowerCase() === "false") return null;

    // Built without a key to check signatures against, nothing could ever be
    // applied — so do not spend a request a day finding that out.
    const publicKey = opts.publicKey ?? UPDATE_PUBLIC_KEY;
    if (!hasPublicKey(publicKey)) return null;

    // Only an installed copy updates itself. A clone or a dev run has no
    // bundles here, and must not get a ~/.sentrinel created on its behalf.
    const dir = opts.dir ?? installDir(env);
    try {
      await stat(join(dir, BUNDLES[0]));
    } catch {
      return null;
    }

    const now = opts.now ?? Date.now();
    if (await stampIsFresh(dir, now)) return null;
    // A stamp that cannot be written is a directory that cannot be written —
    // the bundles could not be replaced either. Checking anyway would learn
    // that with a request on every run, forever.
    if (!(await writeStamp(dir, now))) return null;

    const base = opts.base ?? baseUrl(env);
    const manifest = await fetchManifest({ base, fetchImpl: opts.fetchImpl, timeoutMs: 4000 });
    if (!manifest || !isNewer(manifest.version, VERSION)) return null;
    if (verifyManifest(manifest, publicKey) !== "valid") return null;

    const res = await applyUpdate({ base, dir, manifest, fetchImpl: opts.fetchImpl, publicKey });
    return res.ok && res.updated?.length ? `sentrinel: updated ${res.from} → ${res.to}. Restart to pick it up.` : null;
  } catch {
    return null;
  }
}
