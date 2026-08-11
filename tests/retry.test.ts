// Delivery retry.
//
// The behaviour under test is the one that used to be missing entirely: a
// flush empties its buffers before it posts, so a failed post used to lose the
// window outright. These pin down what is now kept, what is deliberately not,
// and that a drop is never silent.

import { describe, expect, test } from "bun:test";
import { RetryQueue, isRetryable } from "../src/retry";

describe("what is worth retrying", () => {
  test("a transport failure is — it never reached the server", () => {
    expect(isRetryable(undefined)).toBe(true);
  });

  test("5xx is: their problem, probably temporary", () => {
    for (const s of [500, 502, 503, 504]) expect(isRetryable(s)).toBe(true);
  });

  test("429 is, after backing off", () => {
    expect(isRetryable(429)).toBe(true);
  });

  test("other 4xx is not — it would fail identically forever", () => {
    // A bad key or a malformed payload does not become valid by waiting, and
    // queueing it would crowd out payloads that could still land.
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryable(s)).toBe(false);
  });
});

describe("queueing", () => {
  test("a retryable failure is held", () => {
    const q = new RetryQueue();
    expect(q.enqueue("/api/ingest/requests", { a: 1 }, 503)).toBe(true);
    expect(q.size).toBe(1);
  });

  test("an unretryable failure is dropped immediately", () => {
    const q = new RetryQueue();
    expect(q.enqueue("/api/ingest/requests", { a: 1 }, 401)).toBe(false);
    expect(q.size).toBe(0);
  });

  test("a payload is abandoned once its attempts are used up", () => {
    const q = new RetryQueue({ maxAttempts: 3 });
    expect(q.enqueue("/p", {}, 500, 0)).toBe(true);
    expect(q.enqueue("/p", {}, 500, 1)).toBe(true);
    expect(q.enqueue("/p", {}, 500, 2)).toBe(false); // would be the 3rd
    expect(q.drainDropCounts().attempts).toBe(1);
  });

  test("over the cap the OLDEST is dropped, not the newest", () => {
    // During an outage the recent window is what someone is waiting to see;
    // the stale end is the part nobody will look at.
    const q = new RetryQueue({ maxQueued: 3 });
    for (let i = 0; i < 5; i++) q.enqueue("/p", { seq: i }, 500);

    expect(q.size).toBe(3);
    expect(q.drainDropCounts().space).toBe(2);

    const kept = q.due(Date.now() + 10_000_000).map((i) => (i.body as any).seq);
    expect(kept).toEqual([2, 3, 4]);
  });

  test("drop counts reset once reported, so a warning is not repeated forever", () => {
    const q = new RetryQueue({ maxQueued: 1 });
    q.enqueue("/p", {}, 500);
    q.enqueue("/p", {}, 500);
    expect(q.drainDropCounts().space).toBe(1);
    expect(q.drainDropCounts().space).toBe(0);
  });
});

describe("backoff", () => {
  test("nothing is due immediately — that would be a hot loop", () => {
    const q = new RetryQueue({ baseDelayMs: 5_000 });
    q.enqueue("/p", {}, 500);
    expect(q.due(Date.now())).toHaveLength(0);
  });

  test("it becomes due once the delay has passed", () => {
    const q = new RetryQueue({ baseDelayMs: 1_000 });
    q.enqueue("/p", {}, 500);
    expect(q.due(Date.now() + 60_000)).toHaveLength(1);
  });

  test("taking what is due removes it from the queue", () => {
    const q = new RetryQueue({ baseDelayMs: 1_000 });
    q.enqueue("/p", {}, 500);
    q.due(Date.now() + 60_000);
    expect(q.size).toBe(0);
  });

  test("later attempts wait longer, and are jittered", () => {
    // Every instance of a service restarts its collector at the same moment.
    // A fixed delay means they all retry in lockstep and hit a recovering API
    // together, so the delay carries randomness by design.
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const q = new RetryQueue({ baseDelayMs: 10_000 });
      const before = Date.now();
      q.enqueue("/p", {}, 500, 3); // 4th attempt
      const [item] = q.due(Date.now() + 10_000_000);
      delays.add(item.nextAttemptAt - before);
    }
    // Jitter means the same input does not produce the same delay twice.
    expect(delays.size).toBeGreaterThan(1);
    for (const d of delays) {
      expect(d).toBeGreaterThan(10_000); // longer than the first step
    }
  });

  test("the backoff is capped", () => {
    const q = new RetryQueue({ baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 50 });
    const before = Date.now();
    q.enqueue("/p", {}, 500, 20); // 2^20 × 1s without a cap
    const [item] = q.due(Date.now() + 10_000_000);
    expect(item.nextAttemptAt - before).toBeLessThanOrEqual(30_000);
  });
});

describe("the collector's use of it", () => {
  test("a failed flush keeps its payload, and a later flush delivers it", async () => {
    const { MetricsCollector } = await import("../src/collector");

    const seen: string[] = [];
    let failing = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (failing) throw new Error("connection refused");
      seen.push(JSON.parse(init.body).requests?.[0]?.path ?? "?");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const collector = new MetricsCollector({
        serverUrl: "http://collector.test",
        appName: "retry-test",
        env: "test",
        // Effectively immediate, so the test does not sit through a backoff.
        retry: { baseDelayMs: 1 },
      } as any);

      collector.recordRequestLog({
        id: crypto.randomUUID(),
        method: "GET",
        path: "/kept",
        statusCode: 200,
        responseTime: 5,
        timestamp: new Date().toISOString(),
      } as any);

      await collector.flush();
      expect(seen).toHaveLength(0);
      expect(collector.pendingRetries).toBe(1);

      failing = false;
      await new Promise((r) => setTimeout(r, 5));
      await collector.flush();

      expect(seen).toContain("/kept");
      expect(collector.pendingRetries).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a rejected key is not retried — it would never succeed", async () => {
    const { MetricsCollector } = await import("../src/collector");

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
    }) as unknown as typeof fetch;

    try {
      const collector = new MetricsCollector({
        serverUrl: "http://collector.test",
        appName: "retry-test",
        env: "test",
        retry: { baseDelayMs: 1 },
      } as any);

      collector.recordRequestLog({
        id: crypto.randomUUID(),
        method: "GET",
        path: "/rejected",
        statusCode: 200,
        responseTime: 5,
        timestamp: new Date().toISOString(),
      } as any);

      await collector.flush();
      expect(collector.pendingRetries).toBe(0);

      const after = calls;
      await new Promise((r) => setTimeout(r, 5));
      await collector.flush();
      expect(calls).toBe(after); // nothing re-sent
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
