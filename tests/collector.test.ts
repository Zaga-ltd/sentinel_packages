// Delivery at volume.
//
// The failure this guards against: the whole buffer went out as one payload,
// the server caps a batch (5,000 requests or logs, 2,000 errors), and it
// answers anything larger with a 413 that the retry logic treated as
// permanent. Any app over ~167 requests a second lost every request log.

import { afterEach, describe, expect, test } from "bun:test";
import { MetricsCollector, splitPayload } from "../src/collector";
import { all, baseOptions, installCapture } from "./helpers/capture";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const entry = (i: number) => ({
  id: `r${i}`,
  method: "GET",
  path: "/x",
  statusCode: 200,
  responseTime: 1,
  requestSize: 0,
  responseSize: 0,
  timestamp: new Date().toISOString(),
});

const trace = (i: number, spans = 1) => ({
  traceId: i.toString(16).padStart(32, "0"),
  name: "GET /x",
  startTime: new Date().toISOString(),
  durationMs: 1,
  spans: Array.from({ length: spans }, (_, j) => ({ id: `${i}-${j}` })),
});

describe("batches fit the server's caps", () => {
  test("12,000 request logs leave as three batches of at most 5,000", async () => {
    const cap = installCapture();
    restore = cap.restore;
    const c = new MetricsCollector({ ...baseOptions("batching"), buffer: { maxRequestLogs: 50_000 } });
    for (let i = 0; i < 12_000; i++) c.recordRequestLog(entry(i));
    await c.flush();

    const batches = cap.captured["/api/ingest/requests"];
    expect(batches.map((b) => b.requests.length)).toEqual([5_000, 5_000, 2_000]);
  });

  test("traces are batched, by trace count and by span count", async () => {
    const cap = installCapture();
    restore = cap.restore;
    const c = new MetricsCollector(baseOptions("traces"));
    for (let i = 0; i < 1_200; i++) c.recordTrace(trace(i));
    // Two big ones: 6,000 spans each cannot share a 10,000-span batch.
    c.recordTrace(trace(5_000, 6_000));
    c.recordTrace(trace(5_001, 6_000));
    await c.flush();

    const batches = cap.captured["/api/ingest/traces"];
    for (const b of batches) {
      expect(b.traces.length).toBeLessThanOrEqual(500);
      const spans = b.traces.reduce((n: number, t: any) => n + t.spans.length, 0);
      expect(spans).toBeLessThanOrEqual(10_000);
      expect(b.appName).toBe("traces");
    }
    expect(batches.flatMap((b) => b.traces)).toHaveLength(1_202);
    // Hundreds of POSTs became a handful.
    expect(batches.length).toBeLessThan(6);
  });

  test("a 413 halves the batch until the halves are accepted", async () => {
    const cap = installCapture((_path, body) =>
      body.requests.length > 300 ? new Response("too big", { status: 413 }) : new Response("{}")
    );
    restore = cap.restore;
    const c = new MetricsCollector(baseOptions("split"));
    for (let i = 0; i < 1_000; i++) c.recordRequestLog(entry(i));
    await c.flush();

    const accepted = cap.captured["/api/ingest/requests"].filter((b) => b.requests.length <= 300);
    expect(accepted.flatMap((b) => b.requests)).toHaveLength(1_000);
    expect(c.pendingRetries).toBe(0);
  });

  test("splitPayload keeps a metrics reading once, and stops at one record", () => {
    const halves = splitPayload("/api/ingest/metrics", {
      endpoints: [1, 2, 3],
      consumers: [1],
      resourceUsage: { cpuUsage: 1 },
    })!;
    expect(halves).toHaveLength(2);
    expect(halves[0].resourceUsage).toBeDefined();
    expect(halves[1].resourceUsage).toBeUndefined();
    expect(splitPayload("/api/ingest/errors", { errors: [1] })).toBeNull();
  });
});

describe("memory stays bounded", () => {
  test("past the limit the oldest records go, and the drop is reported", async () => {
    const cap = installCapture();
    restore = cap.restore;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const c = new MetricsCollector({ ...baseOptions("bounded"), buffer: { maxRequestLogs: 100 } });
      for (let i = 0; i < 1_000; i++) c.recordRequestLog(entry(i));
      await c.flush();

      const sent = all(cap.captured, "/api/ingest/requests", "requests");
      expect(sent).toHaveLength(100);
      // The newest are the ones kept.
      expect(sent[0].id).toBe("r900");
      expect(warnings.some((w) => w.includes("dropped the oldest 900 request logs"))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});

describe("a hung server cannot stall delivery", () => {
  test("a send times out and its payload is kept for retry", async () => {
    const original = globalThis.fetch;
    restore = () => (globalThis.fetch = original);
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
      })) as any;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const c = new MetricsCollector({ ...baseOptions("timeout"), sendTimeoutMs: 30 });
      c.recordRequestLog(entry(1));
      const started = Date.now();
      await c.flush();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(c.pendingRetries).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  test("a flush asked for while one is running runs after it, not never", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: any[] = [];
    const original = globalThis.fetch;
    restore = () => (globalThis.fetch = original);
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) await gate;
      return new Response("{}");
    }) as any;

    const c = new MetricsCollector(baseOptions("follow-up"));
    c.recordRequestLog(entry(1));
    const first = c.flush();
    c.recordRequestLog(entry(2));
    const second = c.flush();
    release();
    await Promise.all([first, second]);

    expect(bodies.flatMap((b) => b.requests.map((r: any) => r.id))).toEqual(["r1", "r2"]);
  });

  test("stop() waits for a flush in flight, then sends what arrived since", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ids: string[] = [];
    const original = globalThis.fetch;
    restore = () => (globalThis.fetch = original);
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!ids.length) await gate;
      ids.push(...(body.requests ?? []).map((r: any) => r.id));
      return new Response("{}");
    }) as any;

    const c = new MetricsCollector(baseOptions("stop"));
    c.recordRequestLog(entry(1));
    void c.flush();
    c.recordRequestLog(entry(2));
    const stopping = c.stop();
    setTimeout(release, 20);
    await stopping;
    expect(ids).toEqual(["r1", "r2"]);
  });
});

describe("retry budgets are per payload type", () => {
  test("an outage full of request logs cannot evict the metrics", async () => {
    const cap = installCapture(() => new Response("down", { status: 503 }));
    restore = cap.restore;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const c = new MetricsCollector({ ...baseOptions("budgets"), retry: { maxQueued: 2 } });
      c.recordRequest({ method: "GET", path: "/x", statusCode: 200, responseTime: 1, requestSize: 0, responseSize: 0 });
      for (let round = 0; round < 5; round++) {
        c.recordRequestLog(entry(round));
        await c.flush();
      }
      // Two request batches (the cap) plus the one metrics batch.
      expect(c.pendingRetries).toBe(3);
    } finally {
      console.warn = warn;
    }
  });
});
