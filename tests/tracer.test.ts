import { describe, expect, it, test } from "bun:test";
import {
  traceStorage,
  traceSpan,
  tspan,
  traced,
  traceObject,
  generateTraceId,
  generateSpanId,
  generateUuidV7,
  parseTraceParent,
  createClientTracer,
  type TraceContext,
} from "../src/tracer";

describe("OpenTelemetry Distributed Tracing & UUID v7", () => {
  it("generates valid 32-hex traceId, 16-hex spanId, and time-sortable UUID v7", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const uuidv7_1 = generateUuidV7();
    const uuidv7_2 = generateUuidV7();

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);

    // Standard UUID format: 8-4-4-4-12 with 3rd block starting with '7' (version 7)
    expect(uuidv7_1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7_2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Chronological order: uuidv7_1 <= uuidv7_2
    expect(uuidv7_1 <= uuidv7_2).toBe(true);
  });

  it("parses W3C traceparent headers from mobile/web clients correctly", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const header = `00-${traceId}-${spanId}-01`;

    const parsed = parseTraceParent(header);
    expect(parsed?.traceId).toBe(traceId);
    expect(parsed?.parentSpanId).toBe(spanId);
  });

  it("createClientTracer generates valid traceparent headers for mobile/web apps", () => {
    const tracer = createClientTracer({ clientName: "mobile_ios_v4" });
    const headers = tracer.getHeaders();

    expect(headers["x-consumer-id"]).toBe("mobile_ios_v4");
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("captures inner function and DB spans with parent-child relationships", async () => {
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();
    const context: TraceContext = {
      traceId,
      rootSpanId,
      currentSpanId: rootSpanId,
      spans: [],
    };

    await traceStorage.run(context, async () => {
      // Outer span (e.g. DB query)
      await traceSpan("db.query.findUser", async ({ setAttribute }) => {
        setAttribute("db.system", "postgresql");
        setAttribute("db.statement", "SELECT * FROM users WHERE id = $1");

        // Nested inner span (e.g. redis cache check)
        await traceSpan("redis.get", async () => {
          await new Promise((r) => setTimeout(r, 10));
        }, { "db.system": "redis" });
      });
    });

    expect(context.spans.length).toBe(2);

    const redisSpan = context.spans.find((s) => s.name === "redis.get");
    const dbSpan = context.spans.find((s) => s.name === "db.query.findUser");

    expect(dbSpan).toBeDefined();
    expect(redisSpan).toBeDefined();

    expect(dbSpan?.traceId).toBe(traceId);
    expect(dbSpan?.parentId).toBe(rootSpanId);
    expect(dbSpan?.attributes["db.system"]).toBe("postgresql");

    expect(redisSpan?.traceId).toBe(traceId);
    expect(redisSpan?.parentId).toBe(dbSpan?.id); // Nested under dbSpan!
    expect(redisSpan?.attributes["db.system"]).toBe("redis");
    expect(redisSpan?.durationMs).toBeGreaterThanOrEqual(8);
  });

  it("traced() function wrapper auto-infers function name and generates spans", async () => {
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();
    const context: TraceContext = {
      traceId,
      rootSpanId,
      currentSpanId: rootSpanId,
      spans: [],
    };

    const getLoanDetails = traced(async function getLoanDetails(loanId: number) {
      return { id: loanId, amount: 5000 };
    });

    await traceStorage.run(context, async () => {
      const result = await getLoanDetails(42);
      expect(result.amount).toBe(5000);
    });

    expect(context.spans.length).toBe(1);
    expect(context.spans[0].name).toBe("getLoanDetails");
    expect(context.spans[0].parentId).toBe(rootSpanId);
  });

  it("traceObject() automatically instruments all methods on an object", async () => {
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();
    const context: TraceContext = {
      traceId,
      rootSpanId,
      currentSpanId: rootSpanId,
      spans: [],
    };

    class LoanService {
      async findLoan(id: number) {
        return { id, status: "active" };
      }
      async calculateInterest(amount: number) {
        return amount * 0.05;
      }
    }

    const loanService = traceObject(new LoanService(), "LoanService");

    await traceStorage.run(context, async () => {
      await loanService.findLoan(7);
      await loanService.calculateInterest(1000);
    });

    expect(context.spans.length).toBe(2);
    expect(context.spans[0].name).toBe("LoanService.findLoan");
    expect(context.spans[1].name).toBe("LoanService.calculateInterest");
  });
});

// traceSpan accepts both call shapes. The options-second form is what reads
// naturally and is what the demo services use; supporting only the fn-second
// form turned an ordinary call into a runtime TypeError.
describe("traceSpan call shapes", () => {
  test("traceSpan(name, fn) records a span", async () => {
    const ctx = { traceId: "t1", rootSpanId: "r1", currentSpanId: "r1", spans: [] as any[] };
    const out = await traceStorage.run(ctx, () => traceSpan("plain", async () => 42));
    expect(out).toBe(42);
    expect(ctx.spans.map((s) => s.name)).toContain("plain");
  });

  test("traceSpan(name, { kind }, fn) records a span with that kind", async () => {
    const ctx = { traceId: "t2", rootSpanId: "r2", currentSpanId: "r2", spans: [] as any[] };
    const out = await traceStorage.run(ctx, () =>
      traceSpan("openai.chat", { kind: "CLIENT", model: "claude-sonnet-4-5" }, async (span) => {
        span.setAttribute("tokens", 120);
        return "ok";
      })
    );
    expect(out).toBe("ok");
    const span = ctx.spans.find((s) => s.name === "openai.chat");
    expect(span).toBeDefined();
    expect(span.kind).toBe("CLIENT");
    expect(span.attributes.model).toBe("claude-sonnet-4-5");
    expect(span.attributes.tokens).toBe(120);
  });

  test("a missing function is reported clearly, not as 'fn is not a function'", async () => {
    const ctx = { traceId: "t3", rootSpanId: "r3", currentSpanId: "r3", spans: [] as any[] };
    await expect(
      traceStorage.run(ctx, () => traceSpan("broken", { kind: "CLIENT" } as any, undefined as any))
    ).rejects.toThrow(/needs a function to run/);
  });
});
