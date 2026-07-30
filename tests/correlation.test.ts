// What the plugin actually ships for one request, and whether the pieces point
// at each other.
//
// The failure this guards against is subtle: logs and error records carry a
// trace id, but the trace itself was only sent when a handler happened to open
// a child span. Every plain request therefore produced records referencing a
// trace that did not exist — "open the waterfall" led to a 404.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { sentrinelPlugin, getLogger, addRequestContext, traceSpan } from "../src/index";
import { clearRequestScope, resetLogSink } from "../src/logger";

/** Everything the plugin tried to POST, grouped by ingest path. */
type Captured = Record<string, any[]>;

let captured: Captured;
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = {};
  clearRequestScope();
  resetLogSink();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    const path = new URL(url).pathname;
    (captured[path] ??= []).push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLogSink();
});

function makeApp(handler: (ctx: any) => unknown) {
  return new Elysia()
    .use(
      sentrinelPlugin({
        appName: "correlation-test",
        env: "test",
        apiKey: "k",
        serverUrl: "http://sentrinel.local",
        // Short, so the collector's own timer drains the buffers during the
        // test rather than us reaching into its internals.
        flushInterval: 25,
        consumerIdentifier: () => "test_client",
        requestLogging: { enabled: true, sampleRate: 1 },
        logging: { minLevel: "debug" },
      })
    )
    .post("/work", handler);
}

async function callAndFlush(app: Elysia, body: unknown = {}) {
  await app.handle(
    new Request("http://local/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  // The collector flushes on its own timer; give it a couple of ticks.
  await new Promise((r) => setTimeout(r, 200));
}

describe("one request ships a connected set of records", () => {
  test("a handler with no child spans still produces a trace", async () => {
    const log = getLogger("work");
    const app = makeApp(() => {
      log.info("Doing the work", { step: 1 });
      return { ok: true };
    });

    await callAndFlush(app);

    const traces = captured["/api/ingest/traces"] ?? [];
    expect(traces.length).toBeGreaterThan(0);

    const trace = traces[0];
    // The HTTP span alone is a real trace. Without this the logs below would
    // reference a trace id nothing can resolve.
    expect(trace.spans.length).toBeGreaterThanOrEqual(1);
    expect(trace.spans[0].kind).toBe("SERVER");
    expect(trace.spans[0].parentId).toBeNull();
    expect(trace.traceId).toBeTruthy();
  });

  test("the log, the request row and the trace all name the same ids", async () => {
    const log = getLogger(["work", "inner"]);
    const app = makeApp(async () => {
      addRequestContext({ tier: "enterprise", outcome: "done" });
      await traceSpan("db.write", { kind: "DB" }, async () => "written");
      log.warn("Something notable", { reason: "slow_dependency" });
      return { ok: true };
    });

    await callAndFlush(app);

    const trace = (captured["/api/ingest/traces"] ?? [])[0];
    const requestLog = (captured["/api/ingest/requests"] ?? [])[0]?.requests?.[0];
    const appLog = (captured["/api/ingest/logs"] ?? [])[0]?.logs?.find(
      (l: any) => l.message === "Something notable"
    );

    expect(trace).toBeTruthy();
    expect(requestLog).toBeTruthy();
    expect(appLog).toBeTruthy();

    // The three records agree on which request and which trace they belong to.
    expect(requestLog.traceId).toBe(trace.traceId);
    expect(trace.requestLogId).toBe(requestLog.id);
    expect(appLog.requestId).toBe(requestLog.id);
    expect(appLog.traceId).toBe(trace.traceId);

    // The span the log was written inside is really in the trace.
    const spanIds = trace.spans.map((s: any) => s.id);
    expect(spanIds).toContain(appLog.spanId);

    // And the business context rides on the request row itself.
    expect(requestLog.attributes).toMatchObject({ tier: "enterprise", outcome: "done" });

    // The child span nests under the HTTP span rather than floating loose.
    const child = trace.spans.find((s: any) => s.name === "db.write");
    expect(child).toBeTruthy();
    expect(child.parentId).toBe(trace.spans[0].id);
  });

  test("an error record carries the request and trace it came from", async () => {
    const app = makeApp(({ set }: any) => {
      set.status = 500;
      return { message: "it broke" };
    });

    await callAndFlush(app);

    const trace = (captured["/api/ingest/traces"] ?? [])[0];
    const requestLog = (captured["/api/ingest/requests"] ?? [])[0]?.requests?.[0];
    const error = (captured["/api/ingest/errors"] ?? [])[0]?.errors?.[0];

    expect(error).toBeTruthy();
    expect(error.statusCode).toBe(500);
    // This is what lets an issue occurrence open the exact failing request.
    expect(error.requestLogId).toBe(requestLog.id);
    expect(error.traceId).toBe(trace.traceId);
  });

  test("context set once is inherited by code that never saw the request", async () => {
    const log = getLogger("deep");
    function threeLevelsDown() {
      log.info("Wrote a row", { table: "orders" });
    }
    const app = makeApp(async ({ body }: any) => {
      const { withContext } = await import("../src/logger");
      return withContext({ tenantId: body.tenantId }, () => {
        threeLevelsDown();
        return { ok: true };
      });
    });

    await callAndFlush(app, { tenantId: "t_42" });

    const appLog = (captured["/api/ingest/logs"] ?? [])[0]?.logs?.find(
      (l: any) => l.message === "Wrote a row"
    );
    expect(appLog).toBeTruthy();
    expect(appLog.attributes).toMatchObject({ tenantId: "t_42", table: "orders" });
  });
});
