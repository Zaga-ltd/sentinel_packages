#!/usr/bin/env bun
// ─── sentrinel CLI ───────────────────────────────────────────────────────────
//
// The same tools as the MCP server, for agents and harnesses that do not speak
// MCP: pipe the output into a prompt, or let the agent run the command itself.
// Output is Markdown on stdout; every failure goes to stderr with exit 1, so
// a caller can tell an empty result from a broken one.
//
//   sentrinel issues [--status unresolved|resolved|ignored|all] [--period 7d] [--search q] [--limit 20]
//   sentrinel issue <id> [--period 7d]
//   sentrinel logs [--search q] [--level error] [--period 24h] [--limit 50]
//   sentrinel trace <id>
//   sentrinel request <id>
//   sentrinel resolve|ignore|reopen <id>        (needs a may-resolve agent key)
//   --json on any command prints the raw API response instead.
//
// The key is read from SENTRINEL_API_KEY. There is deliberately no --key flag:
// argv is visible to every process on the machine.

import { configFromEnv, SentrinelClient } from "./client";
import {
  issuesToMarkdown,
  issueToMarkdown,
  logsToMarkdown,
  traceToMarkdown,
  requestToMarkdown,
} from "./format";

const USAGE = `sentrinel — Sentrinel for coding agents

  sentrinel issues [--status unresolved|resolved|ignored|all] [--period 7d] [--search q] [--limit 20]
  sentrinel issue <id> [--period 7d]
  sentrinel logs [--search q] [--level error] [--period 24h] [--limit 50]
  sentrinel trace <id>
  sentrinel request <id>
  sentrinel resolve|ignore|reopen <id>      needs an "AI agent — may resolve issues" key
  --json                                    raw API response

Environment: SENTRINEL_API_URL, SENTRINEL_API_KEY (an AI agent key: snt_mcp_… or snt_mcprw_…)`;

export interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny and predictable: --k v, --k=v, and bare --flag. */
export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | boolean | undefined) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

export async function run(argv: string[], client: SentrinelClient): Promise<string> {
  const { command, positional, flags } = parseArgs(argv);
  const json = flags.json === true;
  const out = (data: unknown, render: () => string) => (json ? JSON.stringify(data, null, 2) : render());

  switch (command) {
    case "issues": {
      const status = str(flags.status) === "all" ? "" : str(flags.status);
      const res = await client.listIssues({
        status,
        period: str(flags.period),
        search: str(flags.search),
        limit: num(flags.limit),
      });
      return out(res, () => issuesToMarkdown(res, str(flags.status) ?? "unresolved"));
    }
    case "issue": {
      const [id] = positional;
      if (!id) throw new Error("usage: sentrinel issue <id>");
      const res = await client.getIssue(id, str(flags.period));
      return out(res, () => issueToMarkdown(res));
    }
    case "logs": {
      const res = await client.searchLogs({
        search: str(flags.search),
        level: str(flags.level),
        period: str(flags.period),
        limit: num(flags.limit),
      });
      return out(res, () => logsToMarkdown(res));
    }
    case "trace": {
      const [id] = positional;
      if (!id) throw new Error("usage: sentrinel trace <id>");
      const res = await client.getTrace(id);
      return out(res, () => traceToMarkdown(res));
    }
    case "request": {
      const [id] = positional;
      if (!id) throw new Error("usage: sentrinel request <id>");
      const res = await client.getRequest(id);
      return out(res, () => requestToMarkdown(res));
    }
    case "resolve":
    case "ignore":
    case "reopen": {
      const [id] = positional;
      if (!id) throw new Error(`usage: sentrinel ${command} <id>`);
      const status = command === "resolve" ? "resolved" : command === "ignore" ? "ignored" : "unresolved";
      const res = await client.setIssueStatus(id, status);
      return out(res, () => `Issue ${id} is now ${status}.`);
    }
    case undefined:
    case "help":
    case "--help":
      return USAGE;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    const client = new SentrinelClient(configFromEnv());
    const text = await run(process.argv.slice(2), client);
    process.stdout.write(text + "\n");
  } catch (err) {
    console.error(`sentrinel: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
