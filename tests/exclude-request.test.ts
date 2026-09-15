// ─── Excluding a request by what it carries ─────────────────────────────────
//
// The case excludePaths cannot express: a server that monitors itself must not
// record the reports it posts to itself. They arrive on the same ingest routes
// as every customer's, told apart only by the key they carry. Recording them
// made each report produce another — the count grew on every flush and never
// came back down.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { sentrinelPlugin } from "../src/index";
import { clearRequestScope, resetLogSink } from "../src/logger";

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
    (captured[new URL(url).pathname] ??= []).push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLogSink();
});

const SELF_KEY = "snt_live_self";

function build(excludeRequest: (request: Request) => boolean) {
  return new Elysia()
    .use(
      sentrinelPlugin({
        appName: "self",
        env: "test",
        apiKey: SELF_KEY,
        serverUrl: "http://sentrinel.local",
        flushInterval: 25,
        requestLogging: { enabled: true, sampleRate: 1 },
        excludeRequest,
      })
    )
    .get("/customers", () => "ok")
    .post("/api/ingest/requests", () => ({ ok: true }));
}

const flush = () => new Promise((r) => setTimeout(r, 200));

function recorded(): { paths: string[]; endpoints: string[] } {
  const rows = (captured["/api/ingest/requests"] ?? []).flatMap((b) => b.requests ?? []);
  const endpoints = (captured["/api/ingest/metrics"] ?? []).flatMap((b) => b.endpoints ?? []);
  return { paths: rows.map((r: any) => r.path), endpoints: endpoints.map((e: any) => e.path) };
}

describe("excludeRequest", () => {
  test("a request the predicate names is not recorded anywhere; every other one is", async () => {
    const app = build((request) => request.headers.get("x-api-key") === SELF_KEY);

    // The server's own report, arriving on the ingest route with its own key…
    await app.handle(
      new Request("http://local/api/ingest/requests", { method: "POST", headers: { "x-api-key": SELF_KEY } })
    );
    // …a customer's report on the same route, with a different key…
    await app.handle(
      new Request("http://local/api/ingest/requests", { method: "POST", headers: { "x-api-key": "snt_live_customer" } })
    );
    // …and ordinary traffic.
    await app.handle(new Request("http://local/customers"));
    await flush();

    const { paths, endpoints } = recorded();
    // Two of three: the route is the same, only the key differs.
    expect(paths.filter((p) => p === "/api/ingest/requests")).toHaveLength(1);
    expect(paths).toContain("/customers");
    expect(endpoints.filter((p) => p === "/api/ingest/requests")).toHaveLength(1);
    expect(endpoints).toContain("/customers");
  });

  test("a predicate that throws excludes nothing", async () => {
    const app = build(() => {
      throw new Error("resolver down");
    });
    await app.handle(new Request("http://local/customers"));
    await flush();
    expect(recorded().paths).toContain("/customers");
  });
});
