// The CLI is the MCP server for harnesses without MCP, so it must map to the
// same client calls — and refuse anything it does not understand loudly.

import { describe, expect, test } from "bun:test";
import { parseArgs, run } from "../src/cli";
import { planFromArgs } from "../src/skill";
import type { SentrinelClient } from "../src/client";

function fakeClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { issues: [], logs: [], trace: { id: "t" }, spans: [], id: "r" };
  };
  const client = {
    listIssues: record("listIssues"),
    getIssue: record("getIssue"),
    searchLogs: record("searchLogs"),
    getTrace: record("getTrace"),
    getRequest: record("getRequest"),
    setIssueStatus: record("setIssueStatus"),
  } as unknown as SentrinelClient;
  return { client, calls };
}

describe("parseArgs", () => {
  test("handles --k v, --k=v and bare flags", () => {
    const p = parseArgs(["issue", "abc", "--period", "24h", "--limit=5", "--json"]);
    expect(p.command).toBe("issue");
    expect(p.positional).toEqual(["abc"]);
    expect(p.flags).toEqual({ period: "24h", limit: "5", json: true });
  });
});

describe("run", () => {
  test("issues --status all drops the status filter", async () => {
    const { client, calls } = fakeClient();
    await run(["issues", "--status", "all", "--limit", "5"], client);
    expect(calls[0]).toEqual({ method: "listIssues", args: [{ status: "", period: undefined, search: undefined, limit: 5 }] });
  });

  test("resolve / ignore / reopen map to statuses", async () => {
    const { client, calls } = fakeClient();
    await run(["resolve", "i1"], client);
    await run(["ignore", "i2"], client);
    await run(["reopen", "i3"], client);
    expect(calls.map((c) => c.args)).toEqual([["i1", "resolved"], ["i2", "ignored"], ["i3", "unresolved"]]);
  });

  test("--json returns the raw response", async () => {
    const { client } = fakeClient();
    const out = await run(["issues", "--json"], client);
    expect(JSON.parse(out)).toHaveProperty("issues");
  });

  test("a missing id or unknown command fails with usage", async () => {
    const { client } = fakeClient();
    await expect(run(["issue"], client)).rejects.toThrow(/usage: sentrinel issue/);
    await expect(run(["frobnicate"], client)).rejects.toThrow(/unknown command/);
    expect(await run([], client)).toContain("sentrinel issues");
  });
});

// `sentrinel skill install` — the word after `skill` lands in parseArgs's
// `command`, not in `positional`, and reading the wrong one silently turned
// every install into a print.
describe("skill arguments", () => {
  test("puts the subcommand where the caller looks for it", () => {
    const { command, positional } = parseArgs(["install", "--cursor"]);
    expect(command).toBe("install");
    expect(positional).toEqual([]);
    expect(planFromArgs(command ? [command] : [], { cursor: true }, { home: "/h", cwd: "/r" }).files[0].path).toBe(
      "/r/.cursor/rules/sentrinel.mdc"
    );
  });
});
