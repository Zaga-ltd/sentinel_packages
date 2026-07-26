import { describe, expect, test } from "bun:test";
import { shouldCaptureLog } from "../src/sampling";

describe("head sampling", () => {
  test("errors are always captured regardless of rate", () => {
    for (const code of [400, 404, 429, 500, 503]) {
      const d = shouldCaptureLog(code, 10, { sampleRate: 0 }, () => 0.99);
      expect(d.capture).toBe(true);
      expect(d.sampleRate).toBe(1);
    }
  });

  test("slow requests are always captured regardless of rate", () => {
    const d = shouldCaptureLog(200, 5000, { sampleRate: 0, slowRequestThresholdMs: 2000 }, () => 0.99);
    expect(d.capture).toBe(true);
    expect(d.sampleRate).toBe(1);
  });

  test("fast successes respect the sample rate deterministically", () => {
    // random() = 0.05 < 0.1 → captured
    expect(shouldCaptureLog(200, 50, { sampleRate: 0.1 }, () => 0.05).capture).toBe(true);
    // random() = 0.5 >= 0.1 → dropped
    expect(shouldCaptureLog(200, 50, { sampleRate: 0.1 }, () => 0.5).capture).toBe(false);
  });

  test("captured sampled rows carry their effective rate for extrapolation", () => {
    const d = shouldCaptureLog(200, 50, { sampleRate: 0.25 }, () => 0.1);
    expect(d.capture).toBe(true);
    expect(d.sampleRate).toBe(0.25);
  });

  test("rate defaults to 1 (log everything) and is clamped to [0,1]", () => {
    expect(shouldCaptureLog(200, 50, {}).capture).toBe(true);
    expect(shouldCaptureLog(200, 50, { sampleRate: 7 }, () => 0.999).capture).toBe(true);
    expect(shouldCaptureLog(200, 50, { sampleRate: -1 }, () => 0).capture).toBe(false);
    expect(shouldCaptureLog(200, 50, { sampleRate: NaN }, () => 0.999).capture).toBe(true);
  });

  test("statistical sanity: ~10% of successes at rate 0.1", () => {
    let captured = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      if (shouldCaptureLog(200, 50, { sampleRate: 0.1 }).capture) captured++;
    }
    const share = captured / n;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
  });
});
