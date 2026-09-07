// Custom metrics answer "what did we spend", which tracing never could.
//
// The property that makes them safe to call in a hot loop is the fold: an
// increment mutates a map, and one row per series leaves per flush. If that
// regresses, a counter called per token becomes a network write per token.

import { describe, expect, test, beforeEach } from "bun:test";
import { MetricRegistry, count, gauge, histogram, metricRegistry } from "../src/metrics";

let reg: MetricRegistry;

beforeEach(() => {
  reg = new MetricRegistry();
  // Drain the module-level registry so the shared-instance tests start clean.
  metricRegistry().drain();
});

describe("counters fold rather than accumulate rows", () => {
  test("a thousand increments are one series", () => {
    for (let i = 0; i < 1000; i++) reg.record("llm.tokens", "counter", 3, { model: "deepseek" });

    const points = reg.drain();
    expect(points).toHaveLength(1);
    expect(points[0].sum).toBe(3000);
    expect(points[0].count).toBe(1000);
  });

  test("different labels are different series", () => {
    reg.record("llm.tokens", "counter", 10, { model: "a" });
    reg.record("llm.tokens", "counter", 5, { model: "b" });

    const points = reg.drain();
    expect(points).toHaveLength(2);
    expect(points.map((p) => p.sum).sort((a, b) => a - b)).toEqual([5, 10]);
  });

  // Label order is a property of the call site, not of the series.
  test("the same labels in a different order are one series", () => {
    reg.record("cost", "counter", 1, { model: "x", tier: "pro" });
    reg.record("cost", "counter", 1, { tier: "pro", model: "x" });

    const points = reg.drain();
    expect(points).toHaveLength(1);
    expect(points[0].sum).toBe(2);
  });

  test("draining resets, so the next window starts at zero", () => {
    reg.record("a", "counter", 5);
    reg.drain();
    reg.record("a", "counter", 2);

    expect(reg.drain()[0].sum).toBe(2);
  });
});

describe("gauges and histograms", () => {
  test("a gauge reports its last reading, not a total", () => {
    reg.record("queue.depth", "gauge", 10);
    reg.record("queue.depth", "gauge", 3);

    const [p] = reg.drain();
    expect(p.last).toBe(3);
    expect(p.max).toBe(10);
  });

  test("a histogram carries percentiles", () => {
    for (let i = 1; i <= 100; i++) reg.record("cost.usd", "histogram", i);

    const [p] = reg.drain();
    expect(p.p50).toBeGreaterThan(45);
    expect(p.p50).toBeLessThan(56);
    expect(p.p99).toBeGreaterThan(95);
    expect(p.max).toBe(100);
  });

  // Every aggregate travels regardless of kind, so a counter can still be
  // asked "what was the largest single increment" without re-instrumenting.
  test("a counter still reports min and max", () => {
    reg.record("revenue", "counter", 5);
    reg.record("revenue", "counter", 100);

    const [p] = reg.drain();
    expect(p.min).toBe(5);
    expect(p.max).toBe(100);
  });
});

describe("it cannot become the outage", () => {
  test("NaN and Infinity are refused, not summed", () => {
    reg.record("a", "counter", Number.NaN);
    reg.record("a", "counter", Number.POSITIVE_INFINITY);
    reg.record("a", "counter", 5);

    const [p] = reg.drain();
    // One poisoned value would make every chart drawn from the sum useless.
    expect(p.sum).toBe(5);
    expect(p.count).toBe(1);
  });

  test("a cardinality bomb is bounded rather than unbounded memory", () => {
    for (let i = 0; i < 5000; i++) reg.record("bomb", "counter", 1, { id: String(i) });

    expect(reg.size).toBeLessThanOrEqual(2000);
    expect(reg.droppedSeries).toBeGreaterThan(0);
  });

  test("an empty name is ignored", () => {
    reg.record("", "counter", 1);
    reg.record("   ", "counter", 1);
    expect(reg.drain()).toHaveLength(0);
  });

  test("nothing recorded means nothing to send", () => {
    expect(reg.drain()).toHaveLength(0);
  });
});

describe("the public helpers", () => {
  test("count, gauge and histogram record their kind", () => {
    count("tokens", 7, { model: "m" });
    gauge("depth", 2);
    histogram("latency", 30);

    const kinds = metricRegistry()
      .drain()
      .map((p) => p.kind)
      .sort();
    expect(kinds).toEqual(["counter", "gauge", "histogram"]);
  });

  test("count defaults to one", () => {
    count("hits");
    expect(metricRegistry().drain()[0].sum).toBe(1);
  });
});
