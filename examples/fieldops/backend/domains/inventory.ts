// ─── Inventory domain ────────────────────────────────────────────────────────
// CRUD over parts, plus the reserve call that throws InsufficientStock — the
// single richest source of grouped issues in the demo.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "inventory"]);

export const inventoryRoutes = new Elysia({ prefix: "/api/v1/parts" })
  .get(
    "/",
    async ({ query }) => {
      const rows = await store.listParts({ lowStock: query.lowStock === "true" });
      addRequestContext({ "result.count": rows.length });
      return { parts: rows, count: rows.length };
    },
    { query: t.Object({ lowStock: t.Optional(t.String()) }) }
  )

  .post(
    "/",
    async ({ body, set }) => {
      if (body.onHand < 0) {
        set.status = 422;
        return { error: "ValidationError", message: "onHand cannot be negative" };
      }
      const created = await store.createPart({
        sku: body.sku,
        name: body.name,
        onHand: body.onHand,
        unitPriceCents: body.unitPriceCents,
      });
      log.info("part created", { partId: created.id, sku: created.sku });
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        sku: t.String(),
        name: t.String(),
        onHand: t.Number(),
        unitPriceCents: t.Number(),
      }),
    }
  )

  .get("/:id", async ({ params, set }) => {
    const part = await store.getPart(params.id);
    if (!part) {
      set.status = 404;
      return { error: "NotFound", message: `No part ${params.id}` };
    }
    return { ...part, available: part.onHand - part.reserved };
  })

  .patch("/:id", async ({ params, body, set }) => {
    const updated = await store.updatePart(params.id, body as any);
    if (!updated) {
      set.status = 404;
      return { error: "NotFound", message: `No part ${params.id}` };
    }
    return updated;
  })

  .delete("/:id", async ({ params, set }) => {
    const part = await store.getPart(params.id);
    if (!part) {
      set.status = 404;
      return { error: "NotFound", message: `No part ${params.id}` };
    }
    if (part.reserved > 0) {
      set.status = 409;
      return {
        error: "Conflict",
        message: `${part.sku} has ${part.reserved} reserved and cannot be removed`,
      };
    }
    await store.deletePart(params.id);
    return { ok: true, id: params.id };
  })

  .post(
    "/:id/reserve",
    async ({ params, body }) => {
      // No try/catch: InsufficientStock is meant to escape and become a 500 the
      // dashboard can group. That is the behaviour under test.
      const part = await store.reservePart(params.id, body.qty);
      addRequestContext({ "part.sku": part.sku, "part.reserved": part.reserved });
      return { ok: true, part, available: part.onHand - part.reserved };
    },
    { body: t.Object({ qty: t.Number() }) }
  );
