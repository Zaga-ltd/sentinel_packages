// ─── Ops / chaos domain ──────────────────────────────────────────────────────
//
// Failure modes you can summon on demand. Every other domain fails only when
// its own rules are violated, which makes it awkward to prove that a specific
// dashboard panel works. These routes take that argument away.
//
// `/health` is excluded from instrumentation in server.ts — a health check
// every second would otherwise be the busiest endpoint in the app.

import { Elysia, t } from "elysia";
import { getLogger, tspan, addRequestContext } from "@sentrinel/plugin";

const log = getLogger(["fieldops", "ops"]);

/** Distinct error classes, so Issues has several groups rather than one. */
class UpstreamTimeoutError extends Error {
  constructor(service: string, ms: number) {
    super(`UpstreamTimeout: ${service} did not respond within ${ms}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

class ConfigurationError extends Error {
  constructor(key: string) {
    super(`ConfigurationError: required setting "${key}" is missing`);
    this.name = "ConfigurationError";
  }
}

class DataCorruptionError extends Error {
  constructor(recordId: string) {
    super(`DataCorruption: checksum mismatch on record ${recordId}`);
    this.name = "DataCorruptionError";
  }
}

const FAILURES = [
  () => {
    throw new UpstreamTimeoutError("pricing-service", 3000);
  },
  () => {
    throw new ConfigurationError("BILLING_WEBHOOK_SECRET");
  },
  () => {
    throw new DataCorruptionError(`wo_${crypto.randomUUID().slice(0, 8)}`);
  },
  () => {
    // A plain TypeError — the shape of a real bug rather than a thrown domain
    // error, and it should group separately from the named ones above.
    const nothing: any = null;
    return nothing.invoice.total;
  },
];

export const opsRoutes = new Elysia()
  .get("/health", () => ({ status: "ok", at: new Date().toISOString() }))

  .get(
    "/api/v1/ops/slow",
    async ({ query }) => {
      const ms = Math.min(Number(query.ms ?? 800), 10_000);
      addRequestContext({ "ops.requestedDelayMs": ms });
      await tspan("ops.deliberateStall", async ({ setAttribute }) => {
        setAttribute("stall.ms", ms);
        await Bun.sleep(ms);
      });
      return { sleptMs: ms };
    },
    { query: t.Object({ ms: t.Optional(t.String()) }) }
  )

  /** Fails a configurable share of the time — the classic flaky dependency. */
  .get(
    "/api/v1/ops/flaky",
    async ({ query, set }) => {
      const rate = Math.min(Math.max(Number(query.rate ?? 0.3), 0), 1);
      const roll = Math.random();
      addRequestContext({ "ops.failureRate": rate, "ops.roll": roll });

      if (roll < rate) {
        log.error("flaky endpoint failed", { rate, roll });
        set.status = 503;
        return { error: "ServiceUnavailable", message: "Downstream dependency is unavailable" };
      }
      return { ok: true, roll };
    },
    { query: t.Object({ rate: t.Optional(t.String()) }) }
  )

  /** Throws for real, so the 500 path and stack capture get exercised. */
  .get(
    "/api/v1/ops/boom",
    async ({ query }) => {
      const which = query.kind ? Number(query.kind) : Math.floor(Math.random() * FAILURES.length);
      const failure = FAILURES[which % FAILURES.length]!;
      log.error("about to throw on purpose", { kind: which % FAILURES.length });
      return failure();
    },
    { query: t.Object({ kind: t.Optional(t.String()) }) }
  )

  /** Emits a burst of logs at every level, for the Logs page and its filters. */
  .post(
    "/api/v1/ops/logstorm",
    async ({ body }) => {
      const count = Math.min(Number(body?.count ?? 20), 200);
      for (let i = 0; i < count; i++) {
        const attrs = { iteration: i, batch: body?.label ?? "default" };
        if (i % 7 === 0) log.error("storm: error line", attrs);
        else if (i % 5 === 0) log.warn("storm: warning line", attrs);
        else if (i % 3 === 0) log.debug("storm: debug line", attrs);
        else log.info("storm: info line", attrs);
      }
      return { emitted: count };
    },
    {
      body: t.Optional(
        t.Object({
          count: t.Optional(t.Number()),
          label: t.Optional(t.String()),
        })
      ),
    }
  );
