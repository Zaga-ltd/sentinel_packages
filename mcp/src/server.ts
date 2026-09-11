#!/usr/bin/env bun
// ─── Sentrinel MCP server ────────────────────────────────────────────────────
//
// Hands a coding agent — Claude Code, Codex, anything that speaks MCP — what it
// needs to fix a bug: the issue, its stack trace, the request that caused it,
// the logs around it, the trace behind it. And a way to close the issue once
// the fix has shipped, if the key allows it.
//
// Transport is stdio: the agent launches this as a child process. Nothing here
// listens on a port. Nothing writes to stdout except protocol frames — one
// stray console.log there corrupts the stream — so diagnostics go to stderr.
//
// Configuration, environment only:
//   SENTRINEL_API_URL   e.g. https://api.sentrinel.dev
//   SENTRINEL_API_KEY   an AI agent key (snt_mcp_…) or, to change status, the may-resolve kind (snt_mcprw_…)
//
// The key reaches exactly one app, cannot write telemetry, and cannot touch
// settings. Put a read key in an agent's config and the worst a leak can do is
// read that one app's errors.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { configFromEnv, SentrinelClient } from "./client";
import {
  issuesToMarkdown,
  issueToMarkdown,
  logsToMarkdown,
  traceToMarkdown,
  requestToMarkdown,
  databasesToMarkdown,
  slowQueriesToMarkdown,
  dbActivityToMarkdown,
  dbHealthToMarkdown,
} from "./format";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

const PERIOD = z
  .string()
  .regex(/^\d+\s*[smhdw]?$/i, "a duration like 30m, 24h, 7d, 2w")
  .optional()
  .describe("How far back to look: 30m, 24h, 7d, 2w. Default varies by tool.");

/** How to rank the issue list — the question being asked, in effect. */
const ISSUE_SORT = z
  .enum(["last_seen", "occurrences", "users", "first_seen"])
  .optional()
  .describe(
    "last_seen (default, newest firing) · occurrences (most repeated — the noisiest bug) · " +
      "users (widest blast radius, worst for customers) · first_seen (oldest, the long-standing ones)"
  );

export function buildServer(client: SentrinelClient): McpServer {
  const server = new McpServer({ name: "sentrinel", version: "0.1.0" });

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "The bugs Sentrinel has grouped. Start here — each line carries the issue id to pass to get_issue. " +
        "Use `sort` to ask a different question: `occurrences` for the most repeated, `users` for the one " +
        "hurting the most people, `first_seen` for what has been broken longest.",
      inputSchema: {
        status: z.enum(["unresolved", "resolved", "ignored", "all"]).optional().describe("Default unresolved."),
        period: PERIOD,
        sort: ISSUE_SORT,
        search: z.string().optional().describe("Match against the title or culprit."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const status = a.status === "all" ? "" : a.status;
        const res = await client.listIssues({ ...a, status });
        return ok(issuesToMarkdown(res, a.status ?? "unresolved", a.sort));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get an issue",
      description:
        "Everything about one issue: stack trace, where it fires, who it hit, and the ids of the request and trace behind the latest occurrence.",
      inputSchema: { id: z.string().describe("Issue id from list_issues."), period: PERIOD },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, period }) => {
      try {
        return ok(issueToMarkdown(await client.getIssue(id, period)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description: "Application log lines, with the request and trace each one belongs to.",
      inputSchema: {
        search: z.string().optional().describe("Substring to match in the message."),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        period: PERIOD,
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        return ok(logsToMarkdown(await client.searchLogs(a)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_trace",
    {
      title: "Get a trace",
      description: "The span tree for one request — which call was slow or failed, and what it was inside.",
      inputSchema: { id: z.string().describe("Trace id, from an issue or a request.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return ok(traceToMarkdown(await client.getTrace(id)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_request",
    {
      title: "Get a request",
      description: "One captured HTTP request: headers, body, response, and the error it produced.",
      inputSchema: { id: z.string().describe("Request id, from an issue's recent occurrences.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return ok(requestToMarkdown(await client.getRequest(id)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Databases ───────────────────────────────────────────────────────────
  //
  // A slow endpoint is very often a slow query, and the answer is on the other
  // side of the connection where the application's own telemetry cannot see.
  // These read the collector's view of Postgres, scoped to this app's
  // databases like everything else.

  const SECONDS = z
    .number()
    .int()
    .min(60)
    .max(86_400)
    .optional()
    .describe("Window in seconds. Default 3600 (one hour).");

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description:
        "The Postgres instances reporting for this app, with the id to pass to the other database tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(databasesToMarkdown(await client.listDatabases()));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "slow_queries",
    {
      title: "Slow queries",
      description:
        "Query shapes ranked by their share of execution time, with full text, call counts, cache hit ratio and which endpoints called them. This is where a slow endpoint usually turns out to live.",
      inputSchema: {
        id: z.string().describe("Database id from list_databases."),
        period: SECONDS,
        sort: z.enum(["total", "mean", "calls"]).optional().describe("Default total time."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, period, sort }) => {
      try {
        return ok(slowQueriesToMarkdown(await client.slowQueries(id, { period, sort })));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "db_activity",
    {
      title: "Database activity",
      description:
        "What the database was waiting on — wait events, blocking chains, and the longest-running statements. Use when queries are slow but no single query looks expensive.",
      inputSchema: { id: z.string().describe("Database id."), period: SECONDS },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, period }) => {
      try {
        return ok(dbActivityToMarkdown(await client.dbActivity(id, period)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "db_health",
    {
      title: "Database health",
      description:
        "Connections, idle-in-transaction, commits and rollbacks, deadlocks and temp bytes. The four ways a Postgres database stops, as numbers.",
      inputSchema: { id: z.string().describe("Database id."), period: SECONDS },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, period }) => {
      try {
        return ok(dbHealthToMarkdown(await client.dbHealth(id, period)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "set_issue_status",
    {
      title: "Set issue status",
      description:
        "Mark an issue resolved, ignored, or reopen it. Needs an \"AI agent — may resolve issues\" key; a read-only agent key is refused by the server. Resolve only after the fix has actually shipped.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["resolved", "ignored", "unresolved"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, status }) => {
      try {
        await client.setIssueStatus(id, status);
        return ok(`Issue ${id} is now ${status}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

if (import.meta.main) {
  let client: SentrinelClient;
  try {
    client = new SentrinelClient(configFromEnv());
  } catch (err) {
    console.error(`sentrinel-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  await buildServer(client).connect(new StdioServerTransport());
}
