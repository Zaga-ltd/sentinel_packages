// ─── Analytics domain ────────────────────────────────────────────────────────
// The slow half of the API. Every route here scans the whole store, so these
// are the endpoints that should dominate the p95 table and trip the
// slow-request threshold — which is exactly what makes them worth having.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan } from "@sentrinel/plugin";
import { store, rawStore } from "../store";

const log = getLogger(["fieldops", "analytics"]);

export const analyticsRoutes = new Elysia({ prefix: "/api/v1" })
  .get("/analytics/summary", async () => {
    const [openJobs, parts] = await Promise.all([
      store.listWorkOrders({ status: "in_progress" }),
      store.listParts({ lowStock: true }),
    ]);
    addRequestContext({ "summary.openJobs": openJobs.length, "summary.lowStock": parts.length });
    return {
      openJobs: openJobs.length,
      lowStockParts: parts.length,
      technicians: rawStore.technicians.size,
      customers: rawStore.customers.size,
      generatedAt: new Date().toISOString(),
    };
  })

  .get("/analytics/revenue", async () => {
    const months = await store.revenueByMonth();
    const total = months.reduce((sum, m) => sum + m.cents, 0);
    addRequestContext({ "revenue.totalCents": total });
    return { months, totalCents: total };
  })

  .get("/analytics/technician-utilization", async () => {
    const rows = await store.technicianUtilization();
    return { utilization: rows, count: rows.length };
  })

  /** The heaviest route in the demo — nested scans, on purpose. */
  .get("/analytics/sla", async () => {
    return tspan("analytics.slaReport", async ({ setAttribute }) => {
      const orders = await store.listWorkOrders({});
      await Bun.sleep(120 + Math.random() * 180);

      let met = 0;
      let breached = 0;
      for (const wo of orders) {
        if (wo.status !== "completed") continue;
        // Urgent jobs get a tighter window; the split is arbitrary but stable.
        if (wo.priority === "urgent" || wo.priority === "high") breached++;
        else met++;
      }

      setAttribute("sla.met", met);
      setAttribute("sla.breached", breached);
      log.info("sla report generated", { met, breached, scanned: orders.length });

      return {
        met,
        breached,
        complianceRate: met + breached === 0 ? 1 : met / (met + breached),
        scanned: orders.length,
      };
    });
  })

  .get(
    "/search",
    async ({ query, set }) => {
      if (!query.q || query.q.length < 2) {
        set.status = 422;
        return { error: "ValidationError", message: "q must be at least 2 characters" };
      }
      const results = await store.search(query.q);
      addRequestContext({ "search.q": query.q, "search.hits": results.length });
      return { query: query.q, results, count: results.length };
    },
    { query: t.Object({ q: t.Optional(t.String()) }) }
  );
