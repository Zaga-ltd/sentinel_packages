// Updating installed bundles.
//
// The automatic path replaces code on someone's machine without being asked,
// so the tests are mostly about what it must refuse to do: install a file that
// does not match its published checksum, run more than once a day, or let any
// of its own failures reach the command the user actually ran.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { applyUpdate, autoUpdate, fetchManifest, isNewer, CHECK_INTERVAL_MS } from "../src/update";
import { VERSION } from "../src/version";

const sha = (s: string) => createHash("sha256").update(new Uint8Array(Buffer.from(s))).digest("hex");
const CLI = "new cli bundle";
const MCP = "new mcp bundle";

function server(opts: { version: string; corrupt?: boolean; status?: number }) {
  const manifest = {
    version: opts.version,
    files: { "sentrinel-cli.js": sha(CLI), "sentrinel-mcp.js": sha(MCP) },
  };
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

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrinel-update-"));
  await writeFile(join(dir, "sentrinel-cli.js"), "old cli");
  await writeFile(join(dir, "sentrinel-mcp.js"), "old mcp");
});
afterEach(async () => {
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

describe("applyUpdate", () => {
  test("replaces both bundles when a newer version is published", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.to).toBe("9.9.9");
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe(CLI);
    expect(await readFile(join(dir, "sentrinel-mcp.js"), "utf8")).toBe(MCP);
  });

  test("a bundle that does not match its checksum is refused, and nothing changes", async () => {
    // The boundary. An automatic update that installs whatever arrives is a
    // remote code execution path with extra steps.
    const { fetchImpl } = server({ version: "9.9.9", corrupt: true });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/checksum/i);
    expect(await readFile(join(dir, "sentrinel-cli.js"), "utf8")).toBe("old cli");
    expect(await readFile(join(dir, "sentrinel-mcp.js"), "utf8")).toBe("old mcp");
  });

  test("leaves no .tmp behind when it refuses", async () => {
    const { fetchImpl } = server({ version: "9.9.9", corrupt: true });
    await applyUpdate({ base: "https://x", dir, fetchImpl });
    await expect(stat(join(dir, "sentrinel-cli.js.tmp"))).rejects.toThrow();
  });

  test("says it is current rather than re-downloading", async () => {
    const { fetchImpl, calls } = server({ version: VERSION });
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.updated).toEqual([]);
    expect(calls()).toBe(1); // the manifest only; no bundles fetched
  });

  test("an unreachable server is reported, not thrown", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await applyUpdate({ base: "https://x", dir, fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/check for updates/i);
  });

  test("refuses to write into a directory that holds no install", async () => {
    const empty = await mkdtemp(join(tmpdir(), "sentrinel-empty-"));
    const { fetchImpl } = server({ version: "9.9.9" });
    const res = await applyUpdate({ base: "https://x", dir: empty, fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not an installed copy/i);
    await rm(empty, { recursive: true, force: true });
  });
});

describe("the daily check", () => {
  test("updates, then stays quiet for a day", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    const first = await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl });
    expect(first).toMatch(/updated/i);

    const { fetchImpl: second, calls } = server({ version: "9.9.9" });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl: second })).toBeNull();
    expect(calls()).toBe(0); // the stamp is honoured before any request
  });

  test("checks again once the day is up", async () => {
    const { fetchImpl } = server({ version: "9.9.9" });
    await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl });
    const { fetchImpl: later, calls } = server({ version: "9.9.9" });
    await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl: later, now: Date.now() + CHECK_INTERVAL_MS + 1 });
    expect(calls()).toBeGreaterThan(0);
  });

  test("SENTRINEL_AUTO_UPDATE=false makes no request at all", async () => {
    const { fetchImpl, calls } = server({ version: "9.9.9" });
    const res = await autoUpdate({ base: "https://x", dir, env: { SENTRINEL_AUTO_UPDATE: "false" }, fetchImpl });
    expect(res).toBeNull();
    expect(calls()).toBe(0);
  });

  test("a failing check is silent — it is not the user's problem", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl })).toBeNull();
  });

  test("a corrupt download reports nothing and changes nothing", async () => {
    const { fetchImpl } = server({ version: "9.9.9", corrupt: true });
    expect(await autoUpdate({ base: "https://x", dir, env: {}, fetchImpl })).toBeNull();
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
