// install.sh checks the release the same way the updater does, with its own
// copy of the manifest payload (it runs before any Sentrinel code is on the
// machine). These run that exact copy, lifted out of the script, against
// manifests produced by the real signer — so the two cannot drift apart.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

import { publicKeyOf, signManifest, withPublicKey } from "../src/signature";
import { UPDATE_KEY_PLACEHOLDER } from "../src/update-key";

const INSTALL_SH = await readFile(new URL("../install.sh", import.meta.url), "utf8");

function verifier(): string {
  const start = INSTALL_SH.indexOf("IFS= read -r -d '' VERIFY_JS <<'JS' || true\n");
  const end = INSTALL_SH.indexOf("\nJS\n# sentrinel:verify:end");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return INSTALL_SH.slice(INSTALL_SH.indexOf("\n", start) + 1, end);
}

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const priv = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
  return { priv, pub: publicKeyOf(priv) };
}
const KEY = keypair();
const OTHER = keypair();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SUFFIX = ".tmp.test";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrinel-install-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(opts: { sign?: string | null; key?: string; cli?: string; tamperVersion?: string }) {
  const manifest: Record<string, unknown> = {
    version: "1.2.3",
    files: { "sentrinel-cli.js": sha("cli"), "sentrinel-mcp.js": sha("mcp") },
  };
  const signer = opts.sign === undefined ? KEY.priv : opts.sign;
  if (signer) manifest.signature = signManifest(manifest as any, signer);
  if (opts.tamperVersion) manifest.version = opts.tamperVersion;
  await writeFile(join(dir, `mcp-version.json${SUFFIX}`), JSON.stringify(manifest));
  await writeFile(join(dir, `sentrinel-cli.js${SUFFIX}`), opts.cli ?? "cli");
  await writeFile(join(dir, `sentrinel-mcp.js${SUFFIX}`), "mcp");

  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", verifier()],
    env: {
      ...process.env,
      SNT_MANIFEST: join(dir, `mcp-version.json${SUFFIX}`),
      SNT_KEY: opts.key ?? KEY.pub,
      SNT_DIR: dir,
      SNT_SUFFIX: SUFFIX,
      SNT_FILES: "sentrinel-mcp.js sentrinel-cli.js",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
  };
}

describe("install.sh's release check", () => {
  test("accepts a release signed by the key it carries, and names its version", async () => {
    const r = await run({});
    expect(r.ok).toBe(true);
    expect(r.out).toBe("1.2.3");
  });

  test("refuses a bundle that does not match its checksum", async () => {
    const r = await run({ cli: "tampered" });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/sentrinel-cli\.js does not match its published checksum/);
  });

  test("refuses an unsigned manifest once it has a key", async () => {
    const r = await run({ sign: null });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/not signed/);
  });

  test("refuses another key's signature, and a version changed after signing", async () => {
    expect((await run({ sign: OTHER.priv })).err).toMatch(/does not verify/);
    expect((await run({ tamperVersion: "9.9.9" })).err).toMatch(/does not verify/);
  });

  test("with the placeholder key it still checks every checksum", async () => {
    expect((await run({ sign: null, key: UPDATE_KEY_PLACEHOLDER })).ok).toBe(true);
    expect((await run({ sign: null, key: UPDATE_KEY_PLACEHOLDER, cli: "tampered" })).ok).toBe(false);
  });
});

describe("the key the build writes in", () => {
  test("install.sh carries exactly one key line, the placeholder, in the repository", () => {
    const lines = INSTALL_SH.split("\n").filter((l) => l.startsWith("UPDATE_PUBLIC_KEY="));
    expect(lines).toEqual([`UPDATE_PUBLIC_KEY="${UPDATE_KEY_PLACEHOLDER}"`]);
  });

  test("withPublicKey replaces that line and nothing else", () => {
    const out = withPublicKey(INSTALL_SH, KEY.pub)!;
    expect(out).toContain(`UPDATE_PUBLIC_KEY="${KEY.pub}"`);
    // The JS keeps comparing against the placeholder literal.
    expect(out).toContain(`key !== "${UPDATE_KEY_PLACEHOLDER}"`);
    expect(out.length - INSTALL_SH.length).toBe(KEY.pub.length - UPDATE_KEY_PLACEHOLDER.length);
  });

  test("withPublicKey refuses a script with no key line, or a key that could break out of it", () => {
    expect(withPublicKey("#!/bin/bash\necho hi\n", KEY.pub)).toBeNull();
    expect(withPublicKey(INSTALL_SH, 'x"; rm -rf ~; "')).toBeNull();
  });
});

describe("the launcher", () => {
  test("exports SENTRINEL_HOME, so the updater and profiles find this install", () => {
    const launcher = INSTALL_SH.slice(INSTALL_SH.indexOf("launcher() {"), INSTALL_SH.indexOf("LAUNCH\n  chmod"));
    expect(launcher).toContain('export SENTRINEL_HOME="$INSTALL_DIR"');
  });

  test("fail is defined before anything can call it", () => {
    expect(INSTALL_SH.indexOf("fail() {")).toBeLessThan(INSTALL_SH.indexOf('fail "'));
  });
});
