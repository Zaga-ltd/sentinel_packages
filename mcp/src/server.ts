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
} from "./format";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

const PERIOD = z
  .string()
  .regex(/^\d+[mhd]$/, "a duration like 1h, 24h, 7d")
  .optional()
  .describe("How far back to look: 1h, 24h, 7d. Default varies by tool.");

export function buildServer(client: SentrinelClient): McpServer {
  const server = new McpServer({ name: "sentrinel", version: "0.1.0" });

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "The bugs Sentrinel has grouped, newest-firing first. Start here. Each line has the issue id to pass to get_issue.",
      inputSchema: {
        status: z.enum(["unresolved", "resolved", "ignored", "all"]).optional().describe("Default unresolved."),
        period: PERIOD,
        search: z.string().optional().describe("Match against the title or culprit."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const status = a.status === "all" ? "" : a.status;
        return ok(issuesToMarkdown(await client.listIssues({ ...a, status }), a.status ?? "unresolved"));
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
