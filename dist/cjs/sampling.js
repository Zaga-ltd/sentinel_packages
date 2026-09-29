"use strict";
// ─── Head-sampling decision for request logs ─────────────────────────────────
//
// Pure and deterministic (randomness injected) so it can be unit-tested.
// Contract:
//   * errors (status >= 400) are ALWAYS captured
//   * slow requests (>= slowRequestThresholdMs, default 2000) are ALWAYS captured
//   * everything else is kept with probability sampleRate
//   * captured rows carry their effective sample rate so aggregations can
//     extrapolate honestly (a rate-0.1 row counts as 10)
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldCaptureLog = shouldCaptureLog;
function shouldCaptureLog(statusCode, responseTimeMs, options, random = Math.random) {
    const rate = clampRate(options.sampleRate ?? 1);
    const slowMs = options.slowRequestThresholdMs ?? 2000;
    const mustKeep = statusCode >= 400 || responseTimeMs >= slowMs;
    if (mustKeep)
        return { capture: true, sampleRate: 1 };
    if (rate >= 1)
        return { capture: true, sampleRate: 1 };
    if (rate <= 0)
        return { capture: false, sampleRate: rate };
    return { capture: random() < rate, sampleRate: rate };
}
function clampRate(rate) {
    if (Number.isNaN(rate))
        return 1;
    return Math.min(1, Math.max(0, rate));
}
