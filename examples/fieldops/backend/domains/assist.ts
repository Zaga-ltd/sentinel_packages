// ─── Assist domain ───────────────────────────────────────────────────────────
//
// The AI features a field-service platform actually ships: summarise a job's
// history before you drive to it, draft the "running late" message, and triage
// a free-text fault report into a trade and a priority.
//
// Nothing here calls a real provider — there is no key to leak and no bill to
// run up — but every route emits the span a real client would, so the LLM cost
// page has the same job to do either way. The contract that matters is the
// attribute names: Sentrinel reads `gen_ai.*` (with the older `llm.*` and
// `ai.model.*` spellings accepted as fallbacks), and a span that spells them
// any other way is a span the cost page cannot see.
//
// Token counts and latency are derived from the actual input length rather
// than drawn at random, so cost-per-endpoint stays a number that means
// something across runs.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan } from "@sentrinel/plugin";
import { store } from "../store";

const log = getLogger(["fieldops", "assist"]);

/**
 * Published per-million-token prices. Kept next to the models they price so a
 * rate change is one edit, and so the cost on the span is the cost a finance
 * team would recognise rather than a made-up constant.
 */
const MODELS = {
  "claude-haiku-4-5": { provider: "anthropic", inPerM: 1.0, outPerM: 5.0 },
  "claude-sonnet-5": { provider: "anthropic", inPerM: 3.0, outPerM: 15.0 },
  "gpt-4o-mini": { provider: "openai", inPerM: 0.15, outPerM: 0.6 },
} as const;

type ModelName = keyof typeof MODELS;

/** Roughly four characters to a token — close enough to keep costs honest. */
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function costUsd(model: ModelName, inTokens: number, outTokens: number): number {
  const m = MODELS[model];
  return (inTokens * m.inPerM + outTokens * m.outPerM) / 1_000_000;
}

/**
 * One model call, as a span the cost page can read.
 *
 * The `operation` argument is what the LLM view groups by, so it names the
 * product feature ("summarize", "triage") rather than the HTTP verb — two
 * routes can share a model and still be told apart on the bill.
 */
async function callModel(opts: {
  model: ModelName;
  operation: string;
  prompt: string;
  completion: string;
  /** Milliseconds of "thinking" before the first token. */
  latencyMs?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }> {
  const { model, operation, prompt, completion } = opts;
  const spec = MODELS[model];
  const inputTokens = tokens(prompt);
  const outputTokens = tokens(completion);
  const cost = costUsd(model, inputTokens, outputTokens);

  return tspan(
    `llm.${operation}`,
    async ({ setAttribute }) => {
      // Latency that scales with output length, the way streaming actually
      // behaves — a one-line triage should not look as slow as a summary.
      await Bun.sleep(opts.latencyMs ?? 40 + outputTokens * 1.5);

      setAttribute("gen_ai.system", spec.provider);
      setAttribute("gen_ai.request.model", model);
      setAttribute("gen_ai.response.model", model);
      setAttribute("gen_ai.operation.name", operation);
      setAttribute("gen_ai.usage.input_tokens", inputTokens);
      setAttribute("gen_ai.usage.output_tokens", outputTokens);
      setAttribute("gen_ai.usage.cost", cost);

      return { text: completion, inputTokens, outputTokens, costUsd: cost };
    },
    { kind: "CLIENT" },
  );
}

export const assistRoutes = new Elysia({ prefix: "/api/v1" })
  /** What the app offers, and what each option costs. No model call. */
  .get("/assist/models", () => ({
    models: Object.entries(MODELS).map(([name, m]) => ({
      name,
      provider: m.provider,
      inputPerMillionUsd: m.inPerM,
      outputPerMillionUsd: m.outPerM,
    })),
  }))

  /** Summarise a work order before the technician drives out to it. */
  .post(
    "/assist/summarize",
    async ({ body, set }) => {
      const { workOrderId } = body;
      const wo = await store.getWorkOrder(workOrderId);
      if (!wo) {
        set.status = 404;
        return { error: "Unknown work order" };
      }

      const prompt =
        `Summarise this job for the technician driving to it.\n` +
        `Title: ${wo.title}\nStatus: ${wo.status}\nPriority: ${wo.priority}\n` +
        `Notes: ${(wo as any).notes ?? "none"}\n`;

      const completion =
        `${wo.title} is ${wo.status} at ${wo.priority} priority. ` +
        `Bring standard diagnostic kit; last visit closed without a parts order, ` +
        `so expect the original fault to still be present.`;

      const result = await callModel({
        model: "claude-haiku-4-5",
        operation: "summarize",
        prompt,
        completion,
      });

      // On the request, not just the span: this is what makes the cost
      // attributable to an endpoint in the by-endpoint table.
      addRequestContext({
        "llm.model": "claude-haiku-4-5",
        "llm.costUsd": result.costUsd,
        "workOrder.id": workOrderId,
      });

      return { workOrderId, summary: result.text, usage: result };
    },
    { body: t.Object({ workOrderId: t.String() }) },
  )

  /** Draft the message a dispatcher sends when a job slips. */
  .post(
    "/assist/draft-update",
    async ({ body }) => {
      const { customerName, delayMinutes, reason } = body;

      const prompt =
        `Write a short, apologetic update to ${customerName}. ` +
        `The technician is ${delayMinutes} minutes late because ${reason}. ` +
        `Do not promise a specific arrival time.`;

      const completion =
        `Hi ${customerName} — apologies, our technician is running about ` +
        `${delayMinutes} minutes behind today (${reason}). They are still on their ` +
        `way and we will message again as soon as they are close. Thank you for ` +
        `your patience.`;

      // The longer, more expensive model: drafting customer-facing copy is
      // where the quality difference shows, and where the bill grows.
      const result = await callModel({
        model: "claude-sonnet-5",
        operation: "draft",
        prompt,
        completion,
      });

      addRequestContext({ "llm.model": "claude-sonnet-5", "llm.costUsd": result.costUsd });
      return { draft: result.text, usage: result };
    },
    {
      body: t.Object({
        customerName: t.String(),
        delayMinutes: t.Number(),
        reason: t.String(),
      }),
    },
  )

  /** Turn a free-text fault report into something the scheduler can route. */
  .post(
    "/assist/triage",
    async ({ body }) => {
      const { description } = body;

      const text = description.toLowerCase();
      const trade = text.includes("leak") || text.includes("water")
        ? "plumbing"
        : text.includes("spark") || text.includes("power") || text.includes("breaker")
          ? "electrical"
          : "general";
      const priority = text.includes("flood") || text.includes("smoke") || text.includes("no power")
        ? "urgent"
        : "normal";

      const completion = JSON.stringify({ trade, priority, confidence: 0.82 });

      // The cheap model, because triage is a classification and runs on every
      // inbound report — the volume route, not the quality route.
      const result = await callModel({
        model: "gpt-4o-mini",
        operation: "triage",
        prompt: `Classify this fault report into a trade and a priority:\n${description}`,
        completion,
      });

      addRequestContext({
        "llm.model": "gpt-4o-mini",
        "llm.costUsd": result.costUsd,
        "triage.trade": trade,
        "triage.priority": priority,
      });

      log.info("triaged fault report", { trade, priority });
      return { trade, priority, confidence: 0.82, usage: result };
    },
    { body: t.Object({ description: t.String() }) },
  )

  /**
   * The failure every LLM integration meets in production: the provider says
   * 429. It emits a span with the token counts it did consume, because a
   * rejected call is still billable input on several providers — and a cost
   * page that only counts successes is a cost page that under-reports.
   */
  .post(
    "/assist/bulk-summarize",
    async ({ body, set }) => {
      const { workOrderIds } = body;

      if (workOrderIds.length > 5) {
        await tspan(
          "llm.summarize",
          async ({ setAttribute }) => {
            await Bun.sleep(30);
            setAttribute("gen_ai.system", "anthropic");
            setAttribute("gen_ai.request.model", "claude-haiku-4-5");
            setAttribute("gen_ai.operation.name", "summarize");
            setAttribute("gen_ai.usage.input_tokens", workOrderIds.length * 180);
            setAttribute("gen_ai.usage.output_tokens", 0);
            setAttribute("gen_ai.usage.cost", (workOrderIds.length * 180 * 1.0) / 1_000_000);
            setAttribute("error.type", "rate_limit_exceeded");
          },
          { kind: "CLIENT" },
        );

        log.warn("provider rate limit hit", { batch: workOrderIds.length });
        set.status = 429;
        return { error: "Model provider rate limit — retry with a smaller batch" };
      }

      const summaries = [];
      for (const id of workOrderIds) {
        const wo = await store.getWorkOrder(id);
        if (!wo) continue;
        const result = await callModel({
          model: "claude-haiku-4-5",
          operation: "summarize",
          prompt: `Summarise: ${wo.title} (${wo.status})`,
          completion: `${wo.title} — ${wo.status}, ${wo.priority} priority.`,
        });
        summaries.push({ workOrderId: id, summary: result.text, costUsd: result.costUsd });
      }

      return { summaries, count: summaries.length };
    },
    { body: t.Object({ workOrderIds: t.Array(t.String()) }) },
  );
