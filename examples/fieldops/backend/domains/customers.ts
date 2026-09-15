// ─── Customers domain ────────────────────────────────────────────────────────
// CRUD plus the sites sub-resource. Tier lands in the request context so the
// dashboard can slice traffic by plan without a separate consumer.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "customers"]);

export const customerRoutes = new Elysia({ prefix: "/api/v1/customers" })
  .get(
    "/",
    async ({ query }) => {
      const rows = await store.listCustomers({ tier: query.tier, q: query.q });
      addRequestContext({ "result.count": rows.length, "filter.tier": query.tier ?? null });
      return { customers: rows, count: rows.length };
    },
    {
      query: t.Object({
        tier: t.Optional(t.String()),
        q: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/",
    async ({ body, set }) => {
      if (!body.contactEmail.includes("@")) {
        set.status = 422;
        return { error: "ValidationError", message: "contactEmail must be an email address" };
      }
      const created = await store.createCustomer({
        name: body.name,
        tier: (body.tier as any) ?? "free",
        contactEmail: body.contactEmail,
        phone: body.phone ?? "",
      });
      log.info("customer created", { customerId: created.id, tier: created.tier });
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        name: t.String(),
        contactEmail: t.String(),
        tier: t.Optional(t.String()),
        phone: t.Optional(t.String()),
      }),
    }
  )

  .get("/:id", async ({ params, set }) => {
    const row = await store.getCustomer(params.id);
    if (!row) {
      set.status = 404;
      return { error: "NotFound", message: `No customer ${params.id}` };
    }
    addRequestContext({ "customer.tier": row.tier });
    return row;
  })

  .patch("/:id", async ({ params, body, set }) => {
    const updated = await store.updateCustomer(params.id, body as any);
    if (!updated) {
      set.status = 404;
      return { error: "NotFound", message: `No customer ${params.id}` };
    }
    log.info("customer updated", { customerId: params.id });
    return updated;
  })

  .delete("/:id", async ({ params, set }) => {
    // Enterprise accounts are protected — a 409 that is a business rule rather
    // than a bug, which is worth being able to tell apart in the errors view.
    const existing = await store.getCustomer(params.id);
    if (!existing) {
      set.status = 404;
      return { error: "NotFound", message: `No customer ${params.id}` };
    }
    if (existing.tier === "enterprise") {
      set.status = 409;
      return {
        error: "Conflict",
        message: "Enterprise customers cannot be deleted from the API — contact support",
      };
    }
    await store.deleteCustomer(params.id);
    log.warn("customer deleted", { customerId: params.id });
    return { ok: true, id: params.id };
  })

  .get("/:id/sites", async ({ params, set }) => {
    const customer = await store.getCustomer(params.id);
    if (!customer) {
      set.status = 404;
      return { error: "NotFound", message: `No customer ${params.id}` };
    }
    const sites = await store.sitesForCustomer(params.id);
    return { customer: { id: customer.id, name: customer.name }, sites, count: sites.length };
  });
