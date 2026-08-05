// Request payloads have to survive Elysia's own body parsing.
//
// The plugin used to read the payload inside `app.derive`. `derive` runs at the
// transform stage, which is *after* Elysia has parsed the body — and Elysia
// parses eagerly for any route that declares a `body` schema. Cloning an
// already-drained request does not throw; it reads back as the empty string. So
// the payload silently vanished on exactly the routes a typed Elysia app is
// made of, while untyped routes kept working and hid the bug.
//
// What that looked like in production: every POST in the dashboard showing
// "No request body payload sent (GET/HEAD request or empty body)" next to a
// perfectly recorded response body.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Elysia, t } from "elysia";
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

function plugin() {
  return sentrinelPlugin({
    appName: "payload-test",
    env: "test",
    apiKey: "k",
    serverUrl: "http://sentrinel.local",
    flushInterval: 25,
    requestLogging: {
      enabled: true,
      sampleRate: 1,
      logRequestBody: true,
      logResponseBody: true,
    },
  });
}

async function flush() {
  await new Promise((r) => setTimeout(r, 200));
}

/// The request record for one route.
///
/// Selected by path rather than taken as `rows[0]`: a previous test's collector
/// can still be draining on its own timer, and its record lands in whichever
/// batch arrives next.
function shipped(path: string): any {
  const batches = captured["/api/ingest/requests"] ?? [];
  const rows = batches.flatMap((b) => b.requests ?? []);
  const row = rows.find((r: any) => String(r.path ?? "").endsWith(path));
  expect(row, `no request record for ${path}`).toBeTruthy();
  return row;
}

const BODY = { note: "hello", agent_id: 8 };

function post(app: { handle: (r: Request) => Promise<Response> }, path: string) {
  return app.handle(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    })
  );
}

describe("a POST payload is recorded", () => {
  test("on a route that declares a body schema", async () => {
    // The regression. Elysia parses this route's body before `derive` ever
    // runs, so the old clone-in-derive read back "" and the record shipped
    // without a requestBody at all.
    const app = new Elysia().use(plugin()).post("/typed", ({ body }: any) => ({ got: body }), {
      body: t.Object({ note: t.String(), agent_id: t.Number() }),
    });

    await post(app, "/typed");
    await flush();

    expect(JSON.parse(shipped("/typed").requestBody)).toEqual(BODY);
  });

  test("on a route with no schema", async () => {
    const app = new Elysia().use(plugin()).post("/untyped", () => ({ ok: true }));

    await post(app, "/untyped");
    await flush();

    expect(JSON.parse(shipped("/untyped").requestBody)).toEqual(BODY);
  });

  test("and the handler still receives its body", async () => {
    // Capturing from a clone must leave the real stream intact — otherwise the
    // fix trades a missing payload for a broken route.
    const app = new Elysia().use(plugin()).post("/typed", ({ body }: any) => ({ got: body }), {
      body: t.Object({ note: t.String(), agent_id: t.Number() }),
    });

    const res = await post(app, "/typed");

    expect(await res.json()).toEqual({ got: BODY });
  });

  test("query parameters ship alongside the body", async () => {
    // For a route that takes its input from the query string, these *are* the
    // payload — the dashboard shows them above the body for that reason.
    const app = new Elysia().use(plugin()).post("/withquery", ({ body }: any) => ({ got: body }), {
      body: t.Object({ note: t.String(), agent_id: t.Number() }),
    });

    await app.handle(
      new Request("http://local/withquery?agent_id=8&mode=review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(BODY),
      })
    );
    await flush();

    expect(shipped("/withquery").queryParams).toEqual({ agent_id: "8", mode: "review" });
  });

  test("a GET records no payload rather than an empty one", async () => {
    const app = new Elysia().use(plugin()).get("/read", () => ({ ok: true }));

    await app.handle(new Request("http://local/read"));
    await flush();

    expect(shipped("/read").requestBody).toBeFalsy();
  });
});
