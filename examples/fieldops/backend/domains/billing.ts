// ─── Billing domain ──────────────────────────────────────────────────────────
// Invoices and payments. The payment route calls an external gateway through
// `sentrinelFetch`, so the outbound hop shows up as its own span with its own
// latency — the usual "is it us or is it them" question.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan, sentrinelFetch } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "billing"]);

export const billingRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/invoices",
    async ({ query }) => {
      const rows = await store.listInvoices({ status: query.status, customerId: query.customerId });
      addRequestContext({ "result.count": rows.length });
      return { invoices: rows, count: rows.length };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        customerId: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/invoices",
    async ({ body, set }) => {
      const customer = await store.getCustomer(body.customerId);
      if (!customer) {
        set.status = 422;
        return { error: "ValidationError", message: `Unknown customer ${body.customerId}` };
      }
      if (body.amountCents <= 0) {
        set.status = 422;
        return { error: "ValidationError", message: "amountCents must be positive" };
      }
      const created = await store.createInvoice({
        customerId: body.customerId,
        workOrderId: body.workOrderId,
        amountCents: body.amountCents,
        status: "draft",
      });
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        customerId: t.String(),
        workOrderId: t.String(),
        amountCents: t.Number(),
      }),
    }
  )

  .get("/invoices/:id", async ({ params, set }) => {
    const inv = await store.getInvoice(params.id);
    if (!inv) {
      set.status = 404;
      return { error: "NotFound", message: `No invoice ${params.id}` };
    }
    return inv;
  })

  .post("/invoices/:id/send", async ({ params, set }) => {
    const inv = await store.getInvoice(params.id);
    if (!inv) {
      set.status = 404;
      return { error: "NotFound", message: `No invoice ${params.id}` };
    }
    if (inv.status !== "draft") {
      set.status = 409;
      return { error: "Conflict", message: `Invoice is ${inv.status}, only drafts can be sent` };
    }

    await tspan("email.sendInvoice", async ({ setAttribute }) => {
      setAttribute("invoice.id", inv.id);
      try {
        await sentrinelFetch("https://mail.fieldops.example/v1/send", { method: "POST" });
      } catch {
        // Delivery is best-effort in the demo.
      }
    });

    const updated = await store.updateInvoice(params.id, {
      status: "sent",
      sentAt: new Date().toISOString(),
    });
    log.info("invoice sent", { invoiceId: params.id, amountCents: inv.amountCents });
    return updated;
  })

  .post(
    "/payments",
    async ({ body, set }) => {
      const invoice = await store.getInvoice(body.invoiceId);
      if (!invoice) {
        set.status = 422;
        return { error: "ValidationError", message: `Unknown invoice ${body.invoiceId}` };
      }
      if (invoice.status === "paid") {
        set.status = 409;
        return { error: "Conflict", message: "Invoice is already paid" };
      }

      addRequestContext({
        "payment.method": body.method,
        "payment.amountCents": body.amountCents,
        "invoice.id": invoice.id,
      });

      // The gateway hop. Card payments occasionally decline, which gives the
      // errors view a 402 that is not a bug.
      const outcome = await tspan("gateway.charge", async ({ setAttribute }) => {
        setAttribute("gateway.method", body.method);
        try {
          await sentrinelFetch("https://pay.fieldops.example/v1/charge", { method: "POST" });
        } catch {
          // Gateway unreachable in the demo environment; fall through to the
          // simulated decision below.
        }
        await Bun.sleep(30 + Math.random() * 90);
        const declined = body.method === "card" && Math.random() < 0.12;
        setAttribute("gateway.declined", declined);
        return declined ? "declined" : "settled";
      });

      if (outcome === "declined") {
        log.warn("payment declined", { invoiceId: invoice.id, method: body.method });
        set.status = 402;
        return { error: "PaymentDeclined", message: "The card issuer declined this charge" };
      }

      const payment = await store.createPayment({
        invoiceId: body.invoiceId,
        amountCents: body.amountCents,
        method: body.method as any,
        status: "settled",
      });
      await store.updateInvoice(invoice.id, { status: "paid" });
      log.info("payment settled", { paymentId: payment.id, invoiceId: invoice.id });
      set.status = 201;
      return payment;
    },
    {
      body: t.Object({
        invoiceId: t.String(),
        amountCents: t.Number(),
        method: t.String(),
      }),
    }
  )

  .get("/payments/:id", async ({ params, set }) => {
    const payment = await store.getPayment(params.id);
    if (!payment) {
      set.status = 404;
      return { error: "NotFound", message: `No payment ${params.id}` };
    }
    return payment;
  });
