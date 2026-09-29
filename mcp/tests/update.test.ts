// Updating installed bundles.
//
// The automatic path replaces code on someone's machine without being asked,
// so the tests are mostly about what it must refuse to do: install anything
// from a manifest the publisher did not sign, install a file that does not
// match its published checksum, run more than once a day, or let any of its
// own failures reach the command the user actually ran.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, stat, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

import { applyUpdate, autoUpdate, fetchManifest, isNewer, CHECK_INTERVAL_MS, type Manifest } from "../src/update";
import { manifestPayload, publicKeyOf, signManifest, verifyManifest, hasPublicKey } from "../src/signature";
import { UPDATE_KEY_PLACEHOLDER, UPDATE_PUBLIC_KEY } from "../src/update-key";
import { VERSION } from "../src/version";

const sha = (s: string) => createHash("sha256").update(new Uint8Array(Buffer.from(s))).digest("hex");
const CLI = "new cli bundle";
const MCP = "new mcp bundle";

// A throwaway pair, made fresh for this run. The real private key only ever
// exists where the site is built.
function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const priv = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
  return { priv, pub: publicKeyOf(priv) };
}
const KEY = keypair();
const OTHER = keypair();

function server(opts: {
  version: string;
  corrupt?: boolean;
  status?: number;
  sign?: string | null; // private key; null = unsigned
  tamper?: (m: Manifest) => void;
}) {
  const manifest: Manifest = {
    version: opts.version,
    files: { "sentrinel-cli.js": sha(CLI), "sentrinel-mcp.js": sha(MCP) },
  };
  const signer = opts.sign === undefined ? KEY.priv : opts.sign;
  if (signer) manifest.signature = signManifest(manifest, signer);
  opts.tamper?.(manifest);
  let calls = 0;
  const fetchImpl = (async (url: URL | string) => {
    calls++;
    const u = String(url);
    if (opts.status) return new Response("nope", { status: opts.status });
    if (u.endsWith("mcp-version.json")) return new Response(JSON.stringify(manifest));
    if (u.endsWith("sentrinel-cli.js")) return new Response(opts.corrupt ? "tampered" : CLI);
    if (u.endsWith("sentrinel-mcp.js")) return new Response(MCP);
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, manifest };
}

const leftovers = async (d: string) => (await readdir(d)).filter((f) => f.endsWith(".tmp"));

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrinel-update-"));
  await writeFile(join(dir, "sentrinel-cli.js"), "old cli");
  await writeFile(join(dir, "sentrinel-mcp.js"), "old mcp");
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("version comparison", () => {
  test("only a genuinely newer version counts", () => {
    expect(isNewer("0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("0.2.1", "0.2.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });

  test("a malformed version is not newer, and does not throw", () => {
    expect(isNewer("garbage", VERSION)).toBe(false);
    expect(isNewer("", VERSION)).toBe(false);
  });
});

describe("the signature", () => {
  const m = { version: "1.2.3", files: { "b.js": sha("b"), "a.js": sha("a") } };

  test("round-trips, and covers the version and every hash", () => {
    const signature = signManifest(m, KEY.priv);
    expect(verifyManifest({ ...m, signature }, KEY.pub)).toBe("valid");
    // A newer version number is exactly what an attacker would change.
    expect(verifyManifest({ ...m, version: "9.9.9", signature }, KEY.pub)).toBe("invalid");
    expect(verifyManifest({ ...m, files: { ...m.files, "a.js": sha("evil") }, signature }, KEY.pub)).toBe("invalid");
    expect(verifyManifest({ ...m, files: { ...m.files, "c.js": sha("c") }, signature }, KEY.pub)).toBe("invalid");
  });

  test("another key's signature is not ours", () => {
    expect(verifyManifest({ ...m, signature: signManifest(m, OTHER.priv) }, KEY.pub)).toBe("invalid");
  });

  test("garbage is invalid, absence is unsigned, and neither throws", () => {
    expect(verifyManifest({ ...m, signature: "not base64 at all!" }, KEY.pub)).toBe("invalid");
    expect(verifyManifest({ ...m, signature: "" }, KEY.pub)).toBe("unsigned");
    expect(verifyManifest(m, KEY.pub)).toBe("unsigned");
  });

  test("with the placeholder key nothing verifies", () => {
    const signature = signManifest(m, KEY.priv);
    expect(verifyManifest({ ...m, signature }, UPDATE_KEY_PLACEHOLDER)).toBe("no-key");
    expect(hasPublicKey(UPDATE_KEY_PLACEHOLDER)).toBe(false);
    expect(hasPublicKey(KEY.pub)).toBe(true);
  });

  test("key order does not change what is signed", () => {
    expect(manifestPayload(m)).toBe(manifestPayload({ version: "1.2.3", files: { "a.js": sha("a"), "b.js": sha("b") } }));
  });

  test("a name that could forge a line cannot be signed", () => {
    // The payload is line-based; a newline in a name would smuggle a second
    // `file` line past whoever reviewed the manifest.
    expect(manifestPayload({ version: "1", files: { [`x.js ${sha("x")}\nfile y.js`]: sha("y") } })).toBeNull();
    expect(manifestPayload({ version: "1\nfile a b", files: {} })).toBeNull();
    expect(() => signManifest({ version: "1", files: { "a.js": "short" } }, KEY.priv)).toThrow();
  });

  test("a PEM private key signs the same as base64 DER", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const der = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    expect(publicKeyOf(pem)).toBe(publicKeyOf(der));
    expect(verifyManifest({ ...m, signature: signManifest(m, pem) }, publicKeyOf(der))).toBe("valid");
  });

  test("the shipped key is the placeholder or a real 32-byte ed25519 key", () => {
    // Anything else would silently turn every update off.
    expect(UPDATE_PUBLIC_KEY === UPDATE_KEY_PLACEHOLDER || hasPublicKey(UPDATE_PUBLIC_KEY)).toBe(true);
  });
});

describe("applyUpdate", () => {
  test("replaces both bundles when a newer, signed version is published", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(true);
    expect(res.to).toBe("9.9.9");
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe(CLI);
    expect(await readFile(join(dir, "sentrinel-mcp.js"), "utf8")).toBe(MCP);
    expect(await leftovers(dir)).toEqual([]);
  });

  test("an unsigned manifest is refused before any bundle is fetched, and says what to do", async () => {
    const { fetchImpl, calls } = server({ version: "9.9.9", sign: null });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not signed/);
    expect(res.message).toContain("install-mcp.sh");
    expect(calls()).toBe(1);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
  });

  test("a manifest whose version was raised after signing is refused", async () => {
    const { fetchImpl } = server({ version: "9.9.9", tamper: (m) => void (m.version = "10.0.0") });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/valid signature/);
    expect(await readFile(join(dir, "sentrinel-mcp.js"), "utf8")).toBe("old mcp");
  });

  test("a manifest signed by someone else is refused", async () => {
    const { fetchImpl } = server({ version: "9.9.9", sign: OTHER.priv });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
  });

  test("a copy built without a key explains why it will not update itself", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: UPDATE_KEY_PLACEHOLDER });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/without an update-signing key/);
    expect(res.message).toContain("curl -fsSL https://x/install-mcp.sh | bash");
  });

  test("a bundle that does not match its checksum is refused, and nothing changes", async () => {
    // The boundary. An automatic update that installs whatever arrives is a
    // remote code execution path with extra steps.
    const { fetchImpl } = server({ version: "9.9.9", corrupt: true });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/checksum/i);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
    expect(await readFile(join(dir, "sentrinel-mcp.js"), "utf8")).toBe("old mcp");
    expect(await leftovers(dir)).toEqual([]);
  });

  test("says it is current rather than re-downloading", async () => {
    const { fetchImpl, calls } = server({ version: VERSION });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(true);
    expect(res.updated).toEqual([]);
    expect(calls()).toBe(1); // the manifest only; no bundles fetched
  });

  test("an unreachable server is reported, not thrown", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/check for updates/i);
  });

  test("refuses to write into a directory that holds no install", async () => {
    const empty = await mkdtemp(join(tmpdir(), "sentrinel-empty-"));
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir: empty, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not an installed copy/i);
    await rm(empty, { recursive: true, force: true });
  });

  test("a directory it cannot write to is a result, not a throw", async () => {
    await chmod(dir, 0o555);
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Could not write/);
    expect(res.message).toMatch(/nothing was changed/);
  });

  test("a replace that fails part-way says exactly what state the install is in", async () => {
    // A directory where the server bundle should be: the CLI's rename works,
    // the server's cannot.
    await rm(join(dir, "sentrinel-mcp.js"));
    await mkdir(join(dir, "sentrinel-mcp.js"));
    await writeFile(join(dir, "sentrinel-mcp.js", "keep"), "x");
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl, publicKey: KEY.pub });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Updated sentrinel-cli\.js but could not replace sentrinel-mcp\.js/);
    expect(res.message).toContain("install-mcp.sh");
    expect(await leftovers(dir)).toEqual([]);
  });

  test("two updates at once do not share a temporary file", async () => {
    const a = server({ version: "9.9.9" });
    const b = server({ version: "9.9.9" });
    const [ra, rb] = await Promise.all([
      applyUpdate({ base: "https://x", dir, fetchImpl: a.fetchImpl, publicKey: KEY.pub }),
      applyUpdate({ base: "https://x", dir, fetchImpl: b.fetchImpl, publicKey: KEY.pub }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe(CLI);
    expect(await leftovers(dir)).toEqual([]);
  });
});

describe("the daily check", () => {
  test("updates, then stays quiet for a day", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    const first = await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub });
    expect(first).toMatch(/updated/i);

    const { fetchImpl: second, calls } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl: second, publicKey: KEY.pub })).toBeNull();
    expect(calls()).toBe(0); // the stamp is honoured before any request
  });

  test("checks again once the day is up", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub });
    const { fetchImpl: later, calls } = server({ version: "9.9.9" });
    await autoUpdate({
      base: "https://x",
      dir,
      env: {},
      fetchImpl: later,
      publicKey: KEY.pub,
      now: Date.now() + CHECK_INTERVAL_MS + 1,
    });
    expect(calls()).toBeGreaterThan(0);
  });

  test("SENTRINEL_AUTO_UPDATE=false makes no request at all", async () => {
    const { fetchImpl, calls } = server({ version: "9.9.9" });
    const res = await autoUpdate({
      base: "https://x",
      dir,
      env: { SENTRINEL_AUTO_UPDATE: "false" },
      fetchImpl,
      publicKey: KEY.pub,
    });
    expect(res).toBeNull();
    expect(calls()).toBe(0);
  });

  test("a copy with no signing key never checks, so it never applies anything", async () => {
    const { fetchImpl, calls } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: UPDATE_KEY_PLACEHOLDER })).toBeNull();
    expect(calls()).toBe(0);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
  });

  test("an unsigned or forged manifest is never applied", async () => {
    for (const sign of [null, OTHER.priv]) {
      const d = await mkdtemp(join(tmpdir(), "sentrinel-update-"));
      await writeFile(join(d, "sentrinel-cli.js"), "old cli");
      await writeFile(join(d, "sentrinel-mcp.js"), "old mcp");
      const { fetchImpl, calls } = server({ version: "9.9.9", sign });
      expect(await autoUpdate({ base: "https://x", dir: d, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
      expect(calls()).toBe(1); // the manifest, and no bundle
      expect(await readFile(join(d, "sentrinel-cli.js"), "utf8")).toBe("old cli");
      await rm(d, { recursive: true, force: true });
    }
  });

  test("a stamp it cannot write means no check at all, rather than one on every run", async () => {
    await chmod(dir, 0o555);
    const { fetchImpl, calls } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
    expect(calls()).toBe(0);
  });

  test("a directory with no install is left alone — no request, no stamp", async () => {
    const empty = join(dir, "nothing-here");
    const { fetchImpl, calls } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir: empty, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
    expect(calls()).toBe(0);
    await expect(stat(empty)).rejects.toThrow();
  });

  test("a failing check is silent — it is not the user's problem", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
  });

  test("a filesystem that refuses the replace is silent too", async () => {
    await rm(join(dir, "sentrinel-mcp.js"));
    await mkdir(join(dir, "sentrinel-mcp.js"));
    await writeFile(join(dir, "sentrinel-mcp.js", "keep"), "x");
    const { fetchImpl } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
  });

  test("a corrupt download reports nothing and changes nothing", async () => {
    const { fetchImpl } = server({ version: "9.9.9", corrupt: true });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl, publicKey: KEY.pub })).toBeNull();
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
  });
});

describe("the manifest", () => {
  test("a non-JSON or error response is treated as no manifest", async () => {
    expect(await fetchManifest({ base: "https://x", fetchImpl: server({ version: "1", status: 500 }).fetchImpl })).toBeNull();
  });

  test("the shipped version matches package.json, so the manifest can trust it", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.version).toBe(VERSION);
  });
});
