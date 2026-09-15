// ─── Technicians domain ──────────────────────────────────────────────────────
// Straight CRUD plus a schedule read that is deliberately the slowest thing in
// the directory — it gives the endpoint table an obvious p95 outlier.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "technicians"]);

export const technicianRoutes = new Elysia({ prefix: "/api/v1/technicians" })
  .get(
    "/",
    async ({ query }) => {
      const rows = await store.listTechnicians({
        region: query.region,
        active: query.active === undefined ? undefined : query.active === "true",
      });
      addRequestContext({ "result.count": rows.length });
      return { technicians: rows, count: rows.length };
    },
    {
      query: t.Object({
        region: t.Optional(t.String()),
        active: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/",
    async ({ body, set }) => {
      if (!body.name?.trim()) {
        set.status = 422;
        return { error: "ValidationError", message: "name is required" };
      }
      const created = await store.createTechnician({
        name: body.name,
        email: body.email,
        skills: body.skills ?? [],
        region: body.region ?? "north",
        active: true,
      });
      log.info("technician created", { technicianId: created.id, region: created.region });
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        name: t.String(),
        email: t.String(),
        skills: t.Optional(t.Array(t.String())),
        region: t.Optional(t.String()),
      }),
    }
  )

  .get("/:id", async ({ params, set }) => {
    const row = await store.getTechnician(params.id);
    if (!row) {
      set.status = 404;
      return { error: "NotFound", message: `No technician ${params.id}` };
    }
    return row;
  })

  .patch("/:id", async ({ params, body, set }) => {
    const updated = await store.updateTechnician(params.id, body as any);
    if (!updated) {
      set.status = 404;
      return { error: "NotFound", message: `No technician ${params.id}` };
    }
    log.info("technician updated", { technicianId: params.id });
    return updated;
  })

  .delete("/:id", async ({ params, set }) => {
    const ok = await store.deleteTechnician(params.id);
    if (!ok) {
      set.status = 404;
      return { error: "NotFound", message: `No technician ${params.id}` };
    }
    log.warn("technician deleted", { technicianId: params.id });
    return { ok: true, id: params.id };
  })

  .get("/:id/schedule", async ({ params, set }) => {
    const tech = await store.getTechnician(params.id);
    if (!tech) {
      set.status = 404;
      return { error: "NotFound", message: `No technician ${params.id}` };
    }
    const jobs = await store.technicianSchedule(params.id);
    addRequestContext({ "schedule.jobs": jobs.length, "technician.region": tech.region });
    return { technician: tech, jobs, count: jobs.length };
  });
