// What the agent reads. Each renderer must hand back the ids for the *next*
// call, and none may throw on a field the API stopped sending.

import { describe, expect, test } from "bun:test";
import { ago, issuesToMarkdown, issueToMarkdown, logsToMarkdown, traceToMarkdown, requestToMarkdown } from "../src/format";

describe("issues", () => {
  test("empty is a sentence, not a blank", () => {
    expect(issuesToMarkdown({ issues: [] })).toMatch(/No unresolved issues/);
    expect(issuesToMarkdown({ issues: [] }, "all")).toMatch(/No issues/);
  });

  test("each line carries the id for get_issue", () => {
    const md = issuesToMarkdown({
      issues: [
        { id: "abc-123", title: "TypeError: x is undefined", culprit: "orders.ts:create", occurrences: 42, consumersAffected: 7, lastSeenAt: new Date().toISOString(), statusCode: 500, sampleRequestPath: "/api/orders", regressedAt: "2026-09-01T00:00:00Z" },
      ],
      counts: { unresolved: 1, resolved: 0, ignored: 0 },
    });
    expect(md).toContain("TypeError: x is undefined");
    expect(md).toContain("`orders.ts:create`");
    expect(md).toContain("id: abc-123");
    expect(md).toContain("42 occurrences");
    expect(md).toContain("7 users");
    expect(md).toContain("HTTP 500");
    expect(md).toContain("regressed");
    expect(md).toContain("get_issue");
  });
});

describe("issue detail", () => {
  const detail = {
    issue: { id: "i1", title: "Boom", culprit: "svc.ts:run", status: "unresolved", level: "error", occurrences: 3, firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: new Date().toISOString(), sampleStackTrace: "Error: Boom\n  at run (svc.ts:10)" },
    recent: [{ timestamp: new Date().toISOString(), requestPath: "/api/x", requestLogId: "req-9", traceId: "tr-5", attributes: { orderId: 7 } }],
    endpoints: [{ method: "POST", path: "/api/x", count: 3 }],
    consumers: [{ consumerIdentifier: "user@example.com", count: 2 }],
    stats: { consumersAffected: 1 },
  };

  test("renders the stack trace and points at the request and trace", () => {
    const md = issueToMarkdown(detail);
    expect(md).toContain("# Boom");
    expect(md).toContain("```\nError: Boom");
    expect(md).toContain("`POST /api/x` — 3×");
    expect(md).toContain("user@example.com");
    expect(md).toContain("get_request req-9");
    expect(md).toContain("get_trace tr-5");
    expect(md).toContain("set_issue_status i1 resolved");
    expect(md).toContain('"orderId": 7');
  });

  test("survives a bare issue with nothing else", () => {
    expect(() => issueToMarkdown({ issue: { id: "x" } })).not.toThrow();
    expect(issueToMarkdown({ issue: { id: "x" } })).toContain("# Issue");
  });

  test("a stack trace cannot break out of its fence", () => {
    const md = issueToMarkdown({ issue: { id: "x", sampleStackTrace: "```\nescape" } });
    expect(md.split("```").length).toBe(3); // exactly one open and one close
  });
});

describe("logs", () => {
  test("show level, message and the request they belong to", () => {
    const md = logsToMarkdown({
      logs: [{ timestamp: "2026-09-02T10:00:00Z", level: "error", message: "card declined", requestId: "req-12345678", consumerIdentifier: "u1", attributes: { code: "E42" } }],
      pagination: { total: 1 },
    });
    expect(md).toContain("**ERROR**");
    expect(md).toContain("card declined");
    expect(md).toContain("req req-1234");
    expect(md).toContain("user u1");
    expect(md).toContain('"code":"E42"');
    expect(logsToMarkdown({ logs: [] })).toMatch(/No log lines/);
  });
});

describe("trace", () => {
  test("nests children under parents and marks the failing span", () => {
    const md = traceToMarkdown({
      trace: { id: "t1", name: "POST /checkout", durationMs: 900 },
      spans: [
        { spanId: "a", name: "handler", durationMs: 900, startTime: "2026-09-02T10:00:00.000Z" },
        { spanId: "b", parentSpanId: "a", name: "db.query", durationMs: 800, startTime: "2026-09-02T10:00:00.010Z", status: "error", errorMessage: "timeout" },
        { spanId: "c", parentSpanId: "zzz-missing", name: "orphan", durationMs: 1, startTime: "2026-09-02T10:00:00.020Z" },
      ],
    });
    expect(md).toContain("# Trace POST /checkout");
    expect(md).toContain("- handler — 900ms");
    expect(md).toContain("  - db.query — 800ms **[error]**");
    expect(md).toContain("timeout");
    expect(md).toContain("- orphan"); // a missing parent does not lose the span
  });
});

describe("request", () => {
  test("renders bodies fenced and points at the trace", () => {
    const md = requestToMarkdown({ id: "r1", method: "POST", path: "/api/orders", statusCode: 500, responseTime: 120, requestBody: { sku: "x" }, responseBody: { error: "boom" }, errorMessage: "boom", traceId: "t9" });
    expect(md).toContain("# POST /api/orders");
    expect(md).toContain("HTTP 500");
    expect(md).toContain('"sku": "x"');
    expect(md).toContain("get_trace t9");
  });
});

test("ago is defensive", () => {
  expect(ago(null)).toBe("unknown");
  expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
});
