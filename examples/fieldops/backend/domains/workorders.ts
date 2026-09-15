// ─── Work orders domain ──────────────────────────────────────────────────────
//
// The heart of the demo. `POST /:id/complete` is the deep one: it reserves
// stock, bills the customer, and calls an external notification service, so a
// single request produces a span tree several levels down. When stock is short
// it throws, which is what puts a recurring, grouped issue in front of you
// instead of a one-off 500.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan, sentrinelFetch } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "workorders"]);

export const workOrderRoutes = new Elysia({ prefix: "/api/v1/workorders" })
  .get(
    "/",
    async ({ query }) => {
      const rows = await store.listWorkOrders({
        status: query.status,
        technicianId: query.technicianId,
        customerId: query.customerId,
      });
      addRequestContext({ "result.count": rows.length, "filter.status": query.status ?? null });
      return { workOrders: rows, count: rows.length };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        technicianId: t.Optional(t.String()),
        customerId: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/",
    async ({ body, set }) => {
      const customer = await store.getCustomer(body.customerId);
      if (!customer) {
        set.status = 422;
        return { error: "ValidationError", message: `Unknown customer ${body.customerId}` };
      }
      const created = await store.createWorkOrder({
        customerId: body.customerId,
        siteId: body.siteId,
        title: body.title,
        priority: (body.priority as any) ?? "normal",
      });
      addRequestContext({ "workorder.id": created.id, "customer.tier": customer.tier });
      log.info("work order created", { workOrderId: created.id, priority: created.priority });
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        customerId: t.String(),
        siteId: t.String(),
        title: t.String(),
        priority: t.Optional(t.String()),
      }),
    }
  )

  .get("/:id", async ({ params, set }) => {
    const wo = await store.getWorkOrder(params.id);
    if (!wo) {
      set.status = 404;
      return { error: "NotFound", message: `No work order ${params.id}` };
    }
    addRequestContext({ "workorder.status": wo.status, "workorder.priority": wo.priority });
    return wo;
  })

  .patch("/:id", async ({ params, body, set }) => {
    const updated = await store.updateWorkOrder(params.id, body as any);
    if (!updated) {
      set.status = 404;
      return { error: "NotFound", message: `No work order ${params.id}` };
    }
    return updated;
  })

  .delete("/:id", async ({ params, set }) => {
    const wo = await store.getWorkOrder(params.id);
    if (!wo) {
      set.status = 404;
      return { error: "NotFound", message: `No work order ${params.id}` };
    }
    if (wo.status === "in_progress") {
      set.status = 409;
      return { error: "Conflict", message: "Cannot delete a job that is in progress" };
    }
    await store.deleteWorkOrder(params.id);
    return { ok: true, id: params.id };
  })

  .post(
    "/:id/assign",
    async ({ params, body, set }) => {
      const [wo, tech] = await Promise.all([
        store.getWorkOrder(params.id),
        store.getTechnician(body.technicianId),
      ]);
      if (!wo) {
        set.status = 404;
        return { error: "NotFound", message: `No work order ${params.id}` };
      }
      if (!tech) {
        set.status = 422;
        return { error: "ValidationError", message: `Unknown technician ${body.technicianId}` };
      }
      if (!tech.active) {
        set.status = 409;
        return { error: "Conflict", message: `${tech.name} is not active` };
      }

      const updated = await store.updateWorkOrder(params.id, {
        technicianId: tech.id,
        status: "scheduled",
        scheduledFor: body.scheduledFor ?? new Date().toISOString(),
      });
      log.info("work order assigned", { workOrderId: params.id, technicianId: tech.id });
      return updated;
    },
    {
      body: t.Object({
        technicianId: t.String(),
        scheduledFor: t.Optional(t.String()),
      }),
    }
  )

  .post("/:id/start", async ({ params, set }) => {
    const wo = await store.getWorkOrder(params.id);
    if (!wo) {
      set.status = 404;
      return { error: "NotFound", message: `No work order ${params.id}` };
    }
    if (!wo.technicianId) {
      set.status = 409;
      return { error: "Conflict", message: "Assign a technician before starting the job" };
    }
    const updated = await store.updateWorkOrder(params.id, { status: "in_progress" });
    log.info("work order started", { workOrderId: params.id });
    return updated;
  })

  /**
   * The deep one. Reserves every part, raises an invoice, and notifies the
   * customer — each step its own span under the request.
   */
  .post(
    "/:id/complete",
    async ({ params, body, set }) => {
      const wo = await store.getWorkOrder(params.id);
      if (!wo) {
        set.status = 404;
        return { error: "NotFound", message: `No work order ${params.id}` };
      }
      if (wo.status === "completed") {
        set.status = 409;
        return { error: "Conflict", message: "Job is already completed" };
      }

      addRequestContext({
        "workorder.id": wo.id,
        "workorder.priority": wo.priority,
        "parts.lines": body.partsUsed?.length ?? 0,
      });

      // 1. Reserve stock. Throws InsufficientStock, on purpose and often.
      let partsCents = 0;
      for (const line of body.partsUsed ?? []) {
        const part = await store.reservePart(line.partId, line.qty);
        partsCents += part.unitPriceCents * line.qty;
      }

      // 2. Bill it.
      const labourCents = (body.labourMinutes ?? 60) * 150;
      const invoice = await tspan("billing.raiseInvoice", async ({ setAttribute }) => {
        setAttribute("invoice.partsCents", partsCents);
        setAttribute("invoice.labourCents", labourCents);
        return store.createInvoice({
          customerId: wo.customerId,
          workOrderId: wo.id,
          amountCents: partsCents + labourCents,
          status: "draft",
        });
      });

      // 3. Tell the customer. The notifier is flaky and that is the point —
      //    an external dependency failing should not lose the completed job.
      await tspan("notify.customer", async ({ setAttribute }) => {
        try {
          await sentrinelFetch("https://notify.fieldops.example/v1/send", {
            method: "POST",
            body: JSON.stringify({ invoiceId: invoice.id, customerId: wo.customerId }),
          });
          setAttribute("notify.delivered", true);
        } catch (err) {
          setAttribute("notify.delivered", false);
          log.warn("customer notification failed", {
            invoiceId: invoice.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      });

      const updated = await store.updateWorkOrder(params.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        partsUsed: body.partsUsed ?? [],
      });

      log.info("work order completed", {
        workOrderId: params.id,
        invoiceId: invoice.id,
        amountCents: invoice.amountCents,
      });

      return { workOrder: updated, invoice };
    },
    {
      body: t.Object({
        partsUsed: t.Optional(
          t.Array(t.Object({ partId: t.String(), qty: t.Number() }))
        ),
        labourMinutes: t.Optional(t.Number()),
      }),
    }
  )

  .post(
    "/:id/notes",
    async ({ params, body, set }) => {
      const wo = await store.getWorkOrder(params.id);
      if (!wo) {
        set.status = 404;
        return { error: "NotFound", message: `No work order ${params.id}` };
      }
      const note = { at: new Date().toISOString(), author: body.author, body: body.body };
      const updated = await store.updateWorkOrder(params.id, { notes: [...wo.notes, note] });
      return { ok: true, notes: updated?.notes ?? [] };
    },
    {
      body: t.Object({
        author: t.String(),
        body: t.String(),
      }),
    }
  );
