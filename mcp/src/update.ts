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
// execution: the manifest names a sha256 for each bundle, the download must
// match it, and the replace is atomic. A tampered or truncated download is
// discarded rather than installed. Nothing is fetched more than once a day,
// every failure is silent, and the whole thing is bounded by a short timeout —
// an update check must never be the reason a command is slow or an agent's
// server fails to start.

import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, stat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { VERSION } from "./version";

export interface Manifest {
  version: string;
  files: Record<string, string>; // filename → sha256
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
 * Downloads to `.tmp` and renames, so an interrupted or mismatched download
 * never leaves half a bundle where a working one was. Both files are fetched
 * and verified *before* either is moved, so the CLI and server cannot end up
 * from different versions.
 */
export async function applyUpdate(
  opts: {
    base?: string;
    dir?: string;
    manifest?: Manifest | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
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

  // Not an installed copy — running from a clone, or a moved directory. Saying
  // so beats writing bundles into a directory nothing will load them from.
  try {
    await stat(join(dir, BUNDLES[0]));
  } catch {
    return {
      ok: false,
      from: VERSION,
      to: manifest.version,
      message:
        `${manifest.version} is available, but this is not an installed copy ` +
        `(${dir} has no bundles). Re-run the installer to upgrade.`,
    };
  }

  const staged: Array<[tmp: string, dest: string]> = [];
  for (const name of BUNDLES) {
    const expected = manifest.files[name];
    if (!expected) {
      return { ok: false, from: VERSION, to: manifest.version, message: `The manifest does not list ${name}.` };
    }
    let body: Uint8Array;
    try {
      body = await withTimeout(async (signal) => {
        const res = await f(`${base}/${name}`, { signal });
        if (!res.ok) throw new Error(`${name} returned ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      }, opts.timeoutMs ?? 30_000);
    } catch (err) {
      return {
        ok: false,
        from: VERSION,
        to: manifest.version,
        message: `Could not download ${name}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const got = sha256(body);
    if (got !== expected) {
      // The one case worth being loud about: what arrived is not what was
      // published. Could be a proxy serving a login page, could be worse.
      return {
        ok: false,
        from: VERSION,
        to: manifest.version,
        message: `${name} did not match its published checksum — nothing was changed.`,
      };
    }
    const tmp = join(dir, `${name}.tmp`);
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, body, { mode: 0o644 });
    staged.push([tmp, join(dir, name)]);
  }

  for (const [tmp, dest] of staged) {
    await rename(tmp, dest);
    await chmod(dest, 0o644);
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

async function writeStamp(dir: string, now: number): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STAMP), String(now), { mode: 0o644 });
  } catch {
    /* a read-only home is not a reason to fail a command */
  }
}

/**
 * The daily check, for callers that were doing something else.
 *
 * Returns a line worth showing, or null. Writes the stamp *before* doing any
 * work, so a hanging network cannot turn into a check on every invocation.
 */
export async function autoUpdate(
  opts: {
    base?: string;
    dir?: string;
    env?: Record<string, string | undefined>;
    now?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string | null> {
  const env = opts.env ?? process.env;
  if ((env.SENTRINEL_AUTO_UPDATE ?? "").toLowerCase() === "false") return null;

  const dir = opts.dir ?? installDir(env);
  const now = opts.now ?? Date.now();
  if (await stampIsFresh(dir, now)) return null;
  await writeStamp(dir, now);

  const manifest = await fetchManifest({ base: opts.base ?? baseUrl(env), fetchImpl: opts.fetchImpl, timeoutMs: 4000 });
  if (!manifest || !isNewer(manifest.version, VERSION)) return null;

  const res = await applyUpdate({ base: opts.base ?? baseUrl(env), dir, manifest, fetchImpl: opts.fetchImpl });
  return res.ok && res.updated?.length
    ? `sentrinel: updated ${res.from} → ${res.to}. Restart to pick it up.`
    : null;
}
