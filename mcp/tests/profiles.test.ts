// Switching which app the commands talk to.
//
// A key is pinned to one app, so a profile is a named key and switching is the
// only way to "work on another app". The rules worth pinning: an override for
// one command beats the stored default, switching to something that does not
// exist is refused rather than silently breaking every later command, and a
// key that stopped working is reported next to its profile instead of taking
// the whole list down.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProfiles,
  activeProfile,
  useProfile,
  appForKey,
  profilesToMarkdown,
  DEFAULT_PROFILE,
} from "../src/profiles";

let dir = "";

const write = (name: string, key: string) =>
  writeFile(join(dir, name), `SENTRINEL_API_URL=https://api.example\nSENTRINEL_API_KEY=${key}\n`);

function apiReturning(map: Record<string, string | number>) {
  return (async (url: URL | string, init: any) => {
    const auth = String(init?.headers?.authorization ?? "");
    const key = auth.replace("Bearer ", "");
    const v = map[key];
    if (typeof v === "number") return new Response("{}", { status: v });
    return new Response(JSON.stringify({ apps: [{ name: v }] }));
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrinel-prof-"));
  await write("env", "snt_mcp_aaaaaaaaaaaaaaaa");
  await write("env.merchant", "snt_mcp_bbbbbbbbbbbbbbbb");
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe("listing", () => {
  test("finds the default and every named profile", async () => {
    const names = (await listProfiles(dir, {})).map((p) => p.name).sort();
    expect(names).toEqual(["default", "merchant"]);
  });

  test("the default is active until something says otherwise", async () => {
    expect(await activeProfile(dir, {})).toBe(DEFAULT_PROFILE);
    expect((await listProfiles(dir, {})).find((p) => p.active)?.name).toBe(DEFAULT_PROFILE);
  });

  test("ignores files that are not profiles", async () => {
    await writeFile(join(dir, "sentrinel-cli.js"), "bundle");
    await writeFile(join(dir, ".last-update-check"), "123");
    expect((await listProfiles(dir, {})).map((p) => p.name).sort()).toEqual(["default", "merchant"]);
  });
});

describe("switching", () => {
  test("use sets the active profile, and it sticks", async () => {
    await useProfile("merchant", dir);
    expect(await activeProfile(dir, {})).toBe("merchant");
    expect(await readFile(join(dir, "current"), "utf8")).toBe("merchant");
  });

  test("switching back to default removes the pointer rather than writing a name", async () => {
    await useProfile("merchant", dir);
    await useProfile(DEFAULT_PROFILE, dir);
    expect(await activeProfile(dir, {})).toBe(DEFAULT_PROFILE);
    await expect(readFile(join(dir, "current"), "utf8")).rejects.toThrow();
  });

  test("a profile that does not exist is refused, and nothing changes", async () => {
    await useProfile("merchant", dir);
    await expect(useProfile("nope", dir)).rejects.toThrow(/No profile called "nope"/);
    expect(await activeProfile(dir, {})).toBe("merchant");
  });

  test("the error names what is installed, so the fix is obvious", async () => {
    await expect(useProfile("nope", dir)).rejects.toThrow(/default, merchant/);
  });

  test("SENTRINEL_PROFILE beats the stored default, for one command", async () => {
    await useProfile("merchant", dir);
    expect(await activeProfile(dir, { SENTRINEL_PROFILE: "default" })).toBe("default");
  });
});

describe("naming the app behind a key", () => {
  test("resolves each profile to its app", async () => {
    const f = apiReturning({ snt_mcp_aaaaaaaaaaaaaaaa: "simba", snt_mcp_bbbbbbbbbbbbbbbb: "merchant" });
    const [a, b] = await listProfiles(dir, {});
    expect(await appForKey(a, f)).toBe("simba");
    expect(await appForKey(b, f)).toBe("merchant");
  });

  test("a revoked key is labelled, not thrown", async () => {
    const f = apiReturning({ snt_mcp_aaaaaaaaaaaaaaaa: 401 });
    const [a] = await listProfiles(dir, {});
    expect(await appForKey(a, f)).toMatch(/revoked/i);
  });

  test("one broken key does not take the listing down", async () => {
    const f = apiReturning({ snt_mcp_aaaaaaaaaaaaaaaa: 401, snt_mcp_bbbbbbbbbbbbbbbb: "merchant" });
    const md = await profilesToMarkdown(dir, {}, f);
    expect(md).toContain("merchant");
    expect(md).toMatch(/revoked/i);
  });

  test("the listing marks which one is active", async () => {
    await useProfile("merchant", dir);
    const f = apiReturning({ snt_mcp_aaaaaaaaaaaaaaaa: "simba", snt_mcp_bbbbbbbbbbbbbbbb: "merchant" });
    const md = await profilesToMarkdown(dir, {}, f);
    expect(md).toMatch(/\*\*merchant\*\*.*active/);
  });
});
