import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { sentrinelPlugin } from "../src/index";

/**
 * The plugin must never change whether a route can read its own raw request.
 *
 * Elysia decides ahead of time whether to parse each request's payload. If a
 * hook it cannot statically analyse touches the payload — a `ctx.body` read, a
 * computed member access on the context, or the *whole* context passed to an
 * opaque function — Elysia parses eagerly for every route. That consumes the
 * single-use body stream, so a handler that reads the raw request itself
 * (`await request.text()`, as an HMAC-verified webhook must) then throws
 * "Body already used".
 *
 * These tests pin the plugin to that contract. A handler that reads the raw
 * request must keep working with the plugin installed, under every option that
 * previously broke it.
 */
const rawApp = (plugin: Elysia) =>
  plugin.post("/raw", async ({ request }: any) => {
    // Read the raw request the way a signature-verified webhook does.
    const raw = await request.text();
    return { length: raw.length, raw };
  });

const post = (app: Elysia) =>
  app.handle(
    new Request("http://localhost/raw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment.completed", ref: "sess_1" }),
    })
  );

describe("raw request body is never consumed by the plugin", () => {
  it("leaves the body readable with request logging off", async () => {
    const app = rawApp(
      new Elysia().use(
        sentrinelPlugin({
          appName: "t",
          apiKey: "",
          serverUrl: "http://127.0.0.1:1",
          requestLogging: { enabled: true, logRequestBody: false },
        })
      )
    );
    const res = await post(app);
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBeGreaterThan(0);
  });

  it("leaves the body readable even when logging the payload", async () => {
    // logRequestBody captures via a clone before the handler, so the original
    // still reaches the handler intact.
    const app = rawApp(
      new Elysia().use(
        sentrinelPlugin({
          appName: "t",
          apiKey: "",
          serverUrl: "http://127.0.0.1:1",
          requestLogging: { enabled: true, logRequestBody: true },
        })
      )
    );
    const res = await post(app);
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBeGreaterThan(0);
  });

  it("leaves the body readable with a consumerIdentifier resolver", async () => {
    // Passing the whole context to this resolver was the original trigger.
    const app = rawApp(
      new Elysia().use(
        sentrinelPlugin({
          appName: "t",
          apiKey: "",
          serverUrl: "http://127.0.0.1:1",
          requestLogging: { enabled: true },
          consumerIdentifier: (ctx: any) =>
            ctx.request.headers.get("x-consumer-id"),
        })
      )
    );
    const res = await post(app);
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBeGreaterThan(0);
  });
});
