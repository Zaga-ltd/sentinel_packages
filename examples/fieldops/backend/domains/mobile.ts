// ─── Mobile domain ───────────────────────────────────────────────────────────
//
// The routes the Flutter app actually calls. These matter for the timeline
// story: the app sends `traceparent` on every request, the plugin continues
// that trace instead of starting a new one, and the tap and the server work it
// caused land on a single waterfall.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan } from "@sentrinel/plugin";
import { store, rawStore } from "../store";

const log = getLogger(["fieldops", "mobile"]);

export const mobileRoutes = new Elysia({ prefix: "/api/v1/mobile" })
  /** Everything a technician's phone needs on cold start, in one round trip. */
  .get("/bootstrap", async ({ query }) => {
    const technicianId = query.technicianId;
    const [tech, jobs] = await Promise.all([
      technicianId ? store.getTechnician(technicianId) : Promise.resolve(null),
      technicianId ? store.technicianSchedule(technicianId) : Promise.resolve([]),
    ]);

    addRequestContext({
      "mobile.technicianId": technicianId ?? null,
      "mobile.jobCount": jobs.length,
    });

    return {
      technician: tech,
      jobs,
      serverTime: new Date().toISOString(),
      featureFlags: { offlineMode: true, photoUpload: true, partsScanner: false },
    };
  }, { query: t.Object({ technicianId: t.Optional(t.String()) }) })

  /** Offline queue drain — the app posts everything it buffered. */
  .post(
    "/sync",
    async ({ body, set }) => {
      const ops = body.operations ?? [];
      if (ops.length > 200) {
        set.status = 413;
        return { error: "PayloadTooLarge", message: "Sync batches are capped at 200 operations" };
      }

      const result = await tspan("mobile.applySync", async ({ setAttribute }) => {
        setAttribute("sync.operations", ops.length);
        let applied = 0;
        let rejected = 0;
        for (const op of ops) {
          await Bun.sleep(2);
          // Anything referencing a job that no longer exists is dropped rather
          // than failing the whole batch.
          const exists = rawStore.workOrders.has(op.workOrderId);
          if (exists) applied++;
          else rejected++;
        }
        setAttribute("sync.applied", applied);
        setAttribute("sync.rejected", rejected);
        return { applied, rejected };
      });

      log.info("mobile sync drained", result);
      return { ...result, serverTime: new Date().toISOString() };
    },
    {
      body: t.Object({
        operations: t.Optional(
          t.Array(t.Object({ workOrderId: t.String(), kind: t.String() }))
        ),
      }),
    }
  )

  /** A deliberately fat request body, so payload capture has something to show. */
  .post(
    "/photos",
    async ({ body, set }) => {
      if (!body.dataBase64) {
        set.status = 422;
        return { error: "ValidationError", message: "dataBase64 is required" };
      }
      const bytes = Math.floor((body.dataBase64.length * 3) / 4);
      addRequestContext({ "photo.bytes": bytes, "photo.workOrderId": body.workOrderId });

      if (bytes > 2_000_000) {
        set.status = 413;
        return { error: "PayloadTooLarge", message: "Photos are capped at 2MB" };
      }

      await tspan("storage.putObject", async ({ setAttribute }) => {
        setAttribute("object.bytes", bytes);
        await Bun.sleep(40 + bytes / 20_000);
      });

      set.status = 201;
      return { id: `photo_${crypto.randomUUID().slice(0, 8)}`, bytes };
    },
    {
      body: t.Object({
        workOrderId: t.String(),
        dataBase64: t.String(),
      }),
    }
  )

  .get("/notifications", async ({ query }) => {
    await Bun.sleep(10);
    const unreadOnly = query.unreadOnly === "true";
    const items = [
      { id: "ntf_1", kind: "assignment", read: false, body: "New job assigned" },
      { id: "ntf_2", kind: "sla", read: true, body: "SLA warning on job 42" },
      { id: "ntf_3", kind: "stock", read: false, body: "Part SKU-1004 is low" },
    ].filter((n) => (unreadOnly ? !n.read : true));
    return { notifications: items, count: items.length };
  }, { query: t.Object({ unreadOnly: t.Optional(t.String()) }) });
