// Express, Next.js and Bun, recording through the shared core.
//
// What each used to get wrong, pinned here:
//   * Next: the middleware blanked every route and nothing was ever recorded.
//   * Express: thrown errors were never captured, the route was read before
//     routing, and handlers ran outside any trace context.
//   * All three: no trace context, so traceSpan() recorded nothing and error
//     rows carried trace ids that resolved to nothing.
//   * All three: headers and query strings shipped unmasked by default.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { createSentrinelNext, routeFromParams } from "../src/next";
import { sentrinelExpressMiddleware, sentrinelErrorHandler } from "../src/express";
import { sentrinelBunMiddleware } from "../src/bun";
import { traceSpan } from "../src/tracer";
import { getLogger, resetLogSink, clearRequestScope } from "../src/logger";
import { all, baseOptions, installCapture, type Captured } from "./helpers/capture";

let captured: Captured;
let restore: () => void;
let seq = 0;
const uniqueApp = (name: string) => `${name}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

beforeEach(() => {
  clearRequestScope();
  resetLogSink();
  ({ captured, restore } = installCapture());
});
afterEach(() => restore());

// ─── Next.js App Router ─────────────────────────────────────────────────────

describe("Next.js — withSentrinel on an App Router route", () => {
  test("the route's own response reaches the client, and is recorded as it was", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const GET = withSentrinel(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
      const { id } = await ctx.params;
      return Response.json({ id }, { status: 201 });
    });

    const res = await GET(new Request("http://shop.test/api/orders/42"), {
      params: Promise.resolve({ id: "42" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "42" });

    await flush();
    const endpoints = all(captured, "/api/ingest/metrics", "endpoints");
    expect(endpoints).toHaveLength(1);
    // The pattern, rebuilt from params — not one endpoint per order id.
    expect(endpoints[0].path).toBe("/api/orders/[id]");
    expect(endpoints[0].statusCodes).toEqual({ "201": 1 });
  });

  test("a thrown error is recorded with its stack, and still thrown", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const POST = withSentrinel(async (_req: Request, _ctx: unknown) => {
      throw new TypeError("cart is undefined");
    });

    await expect(POST(new Request("http://shop.test/api/checkout", { method: "POST" }), {})).rejects.toThrow(
      "cart is undefined"
    );
    await flush();

    const [error] = all(captured, "/api/ingest/errors", "errors");
    expect(error.statusCode).toBe(500);
    expect(error.errorType).toBe("TypeError");
    expect(error.stackTrace).toContain("cart is undefined");
    const [trace] = all(captured, "/api/ingest/traces", "traces");
    expect(error.traceId).toBe(trace.traceId);
  });

  test("redirect() and notFound() are control flow, not 500s", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const GET = withSentrinel(async (_req: Request, _ctx: unknown) => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    });
    await expect(GET(new Request("http://shop.test/api/account"), {})).rejects.toThrow();
    await flush();

    expect(all(captured, "/api/ingest/metrics", "endpoints")[0].statusCodes).toEqual({ "307": 1 });
    expect(all(captured, "/api/ingest/errors", "errors")).toHaveLength(0);
  });

  test("traceSpan() inside the handler lands in the request's trace, continuing the caller's", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const GET = withSentrinel(async (_req: Request, _ctx: unknown) => {
      await traceSpan("db.orders.find", { kind: "DB" }, async () => "rows");
      return Response.json([]);
    });
    const traceId = "a".repeat(32);
    await GET(
      new Request("http://shop.test/api/orders", { headers: { traceparent: `00-${traceId}-${"b".repeat(16)}-01` } }),
      {}
    );
    await flush();

    const [trace] = all(captured, "/api/ingest/traces", "traces");
    expect(trace.traceId).toBe(traceId);
    const root = trace.spans.find((s: any) => s.kind === "SERVER");
    expect(root.parentId).toBe("b".repeat(16));
    const child = trace.spans.find((s: any) => s.name === "db.orders.find");
    expect(child.parentId).toBe(root.id);
  });

  test("an end user's x-api-key is never taken as the consumer; the browser's guest id is", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const GET = withSentrinel(async (_req: Request, _ctx: unknown) => new Response("ok"));
    await GET(
      new Request("http://shop.test/api/me", {
        headers: {
          "x-api-key": "sk_live_theirs",
          "x-sentrinel-consumer": "guest:anon_abc12345",
          "x-sentrinel-device": "anon_abc12345",
        },
      }),
      {}
    );
    await flush();

    const consumers = all(captured, "/api/ingest/metrics", "consumers");
    expect(consumers.map((c) => c.identifier)).toEqual(["guest:anon_abc12345"]);
    const [trace] = all(captured, "/api/ingest/traces", "traces");
    expect(trace.spans[0].attributes["device.id"]).toBe("anon_abc12345");
  });

  test("a claimed consumer that is not a guest id is ignored unless the app trusts its shape", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("next")));
    const GET = withSentrinel(async (_req: Request, _ctx: unknown) => new Response("ok"));
    await GET(new Request("http://shop.test/api/me", { headers: { "x-sentrinel-consumer": "admin" } }), {});
    await flush();
    expect(all(captured, "/api/ingest/metrics", "consumers")).toHaveLength(0);
  });

  test("headers, query strings and bodies are masked by default", async () => {
    const { withSentrinel, flush } = createSentrinelNext({
      ...baseOptions(uniqueApp("next")),
      requestLogging: { enabled: true, logRequestHeaders: true, logRequestBody: true, logResponseBody: true },
    });
    const POST = withSentrinel(async (req: Request, _ctx: unknown) => {
      const body = await req.json();
      return Response.json({ ok: true, echoed: body.email, access_token: "tok_resp" });
    });
    const res = await POST(
      new Request("http://shop.test/api/login?next=/home&token=reset_abc&code=oauth_xyz", {
        method: "POST",
        headers: { authorization: "Bearer secret", cookie: "sid=1", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.c", password: "hunter2" }),
      }),
      {}
    );
    // The handler still read its own body in full.
    expect((await res.json()).echoed).toBe("a@b.c");
    // The response body is read after the response is handed back.
    await new Promise((r) => setTimeout(r, 20));
    await flush();

    const [row] = all(captured, "/api/ingest/requests", "requests");
    expect(row.requestHeaders.authorization).toBe("***");
    expect(row.requestHeaders.cookie).toBe("***");
    expect(row.queryParams).toEqual({ next: "/home", token: "***", code: "***" });
    expect(JSON.parse(row.requestBody)).toEqual({ email: "a@b.c", password: "***" });
    expect(JSON.parse(row.responseBody).access_token).toBe("***");
  });
});

describe("Next.js — Pages Router API route", () => {
  function fakeRes() {
    const res: any = new EventEmitter();
    const headers: Record<string, string> = {};
    res.statusCode = 200;
    res.headersSent = false;
    res.writableFinished = false;
    res.setHeader = (k: string, v: string) => (headers[k.toLowerCase()] = v);
    res.getHeader = (k: string) => headers[k.toLowerCase()];
    res.write = () => true;
    res.end = (_chunk?: unknown) => {
      res.writableFinished = true;
      res.emit("finish");
      res.emit("close");
    };
    return res;
  }

  test("status and route come from the response Next sent", async () => {
    const { withSentrinel, flush } = createSentrinelNext(baseOptions(uniqueApp("pages")));
    const handler = withSentrinel((_req: any, res: any) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "no such order" }));
    });
    const res = fakeRes();
    await handler(
      { url: "/api/orders/77?expand=1", method: "GET", headers: {}, query: { id: "77", expand: "1" } },
      res
    );
    await flush();

    const [endpoint] = all(captured, "/api/ingest/metrics", "endpoints");
    expect(endpoint.path).toBe("/api/orders/[id]");
    expect(endpoint.statusCodes).toEqual({ "404": 1 });
    expect(all(captured, "/api/ingest/errors", "errors")[0].errorMessage).toBe("no such order");
  });
});

test("routeFromParams rebuilds patterns, catch-alls included", () => {
  expect(routeFromParams("/api/users/5/posts/9", { userId: "5", postId: "9" })).toBe(
    "/api/users/[userId]/posts/[postId]"
  );
  expect(routeFromParams("/docs/a/b/c", { slug: ["a", "b", "c"] })).toBe("/docs/[...slug]");
  expect(routeFromParams("/static", {})).toBeUndefined();
});

// ─── Express ────────────────────────────────────────────────────────────────
//
// A dispatcher with Express's semantics for what matters here: layers run in
// order, a throw or next(err) skips to the next four-argument layer, and
// `req.route` exists only once a route has matched.

type Layer = (...args: any[]) => void;

function expressLike(layers: Layer[]) {
  return (req: any, res: any) => {
    req.originalUrl = req.url;
    let i = 0;
    const next = (err?: unknown): void => {
      const layer = layers[i++];
      if (!layer) {
        res.statusCode = err ? 500 : 404;
        res.end(err ? "Internal Server Error" : "Not Found");
        return;
      }
      try {
        if (err !== undefined) {
          if (layer.length === 4) layer(err, req, res, next);
          else next(err);
        } else if (layer.length === 4) next();
        else layer(req, res, next);
      } catch (e) {
        next(e);
      }
    };
    next();
  };
}

function route(method: string, pattern: string, handler: Layer): Layer {
  const re = new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}$`);
  return (req: any, res: any, next: any) => {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method !== method || !re.test(path)) return next();
    req.route = { path: pattern };
    req.baseUrl = "";
    handler(req, res, next);
  };
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

describe("Express", () => {
  test("a thrown error reaches sentrinelErrorHandler, stack and matched route intact", async () => {
    const mw = sentrinelExpressMiddleware(baseOptions(uniqueApp("express")));
    const app = expressLike([
      mw,
      route("GET", "/orders/:id", () => {
        throw new RangeError("order total is negative");
      }),
      sentrinelErrorHandler(),
    ]);
    const { base, close } = await serve(app);
    // The real fetch — the capture replaces globalThis.fetch for the plugin only.
    const res = await (restore(), fetch(`${base}/orders/31`));
    ({ captured, restore } = installCapture());
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 10));
    await mw.flush();
    await close();

    const [error] = all(captured, "/api/ingest/errors", "errors");
    expect(error.errorType).toBe("RangeError");
    expect(error.stackTrace).toContain("order total is negative");
    // Read after routing — the pattern, not the URL.
    expect(error.path).toBe("/orders/:id");
  });

  test("handlers run inside the trace: spans and logs attach to the request", async () => {
    const mw = sentrinelExpressMiddleware({
      ...baseOptions(uniqueApp("express")),
      requestLogging: { enabled: true, logRequestHeaders: true },
    });
    const log = getLogger("orders");
    const app = expressLike([
      mw,
      route("GET", "/orders/:id", async (_req: any, res: any) => {
        await traceSpan("db.orders.get", async () => 1);
        log.info("Loaded order");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }),
    ]);
    const { base, close } = await serve(app);
    restore();
    await fetch(`${base}/orders/8?api_key=abc`, { headers: { authorization: "Bearer x", "x-api-key": "k2" } });
    ({ captured, restore } = installCapture());
    await new Promise((r) => setTimeout(r, 10));
    await mw.flush();
    await close();

    const [trace] = all(captured, "/api/ingest/traces", "traces");
    const span = trace.spans.find((s: any) => s.name === "db.orders.get");
    expect(span.parentId).toBe(trace.spans[0].id);
    const logLine = all(captured, "/api/ingest/logs", "logs").find((l) => l.message === "Loaded order");
    expect(logLine.traceId).toBe(trace.traceId);

    const [row] = all(captured, "/api/ingest/requests", "requests");
    expect(row.route).toBe("/orders/:id");
    expect(row.traceId).toBe(trace.traceId);
    expect(row.requestHeaders.authorization).toBe("***");
    expect(row.requestHeaders["x-api-key"]).toBe("***");
    expect(row.queryParams.api_key).toBe("***");
  });
});

test("expressRoute keeps a router's mount path even after an error left the router", async () => {
  const { expressRoute } = await import("../src/express");
  // Inside the router: baseUrl is still set.
  expect(expressRoute({ headers: {}, originalUrl: "/api/orders/4", baseUrl: "/api", route: { path: "/orders/:id" } })).toBe(
    "/api/orders/:id"
  );
  // After an error: Express has restored baseUrl to the parent's "".
  expect(expressRoute({ headers: {}, originalUrl: "/api/boom/7?x=1", baseUrl: "", route: { path: "/boom/:id" } })).toBe(
    "/api/boom/:id"
  );
  expect(expressRoute({ headers: {}, originalUrl: "/api", baseUrl: "", route: { path: "/" } })).toBe("/api");
  expect(expressRoute({ headers: {}, originalUrl: "/x" })).toBeUndefined();
});

// ─── Bun ────────────────────────────────────────────────────────────────────

describe("Bun.serve adapter", () => {
  test("records the error a response described, the trace, and masks the query", async () => {
    const fetchHandler = sentrinelBunMiddleware(
      { ...baseOptions(uniqueApp("bun")), requestLogging: { enabled: true } },
      async () => {
        await traceSpan("cache.get", async () => null);
        return Response.json({ message: "invoice locked" }, { status: 409 });
      }
    );
    const res = await fetchHandler(new Request("http://api.test/invoices/5?signature=s3cr3t&page=2"), null);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("invoice locked");
    await new Promise((r) => setTimeout(r, 20));
    await fetchHandler.flush();

    const [error] = all(captured, "/api/ingest/errors", "errors");
    expect(error.errorMessage).toBe("invoice locked");
    const [trace] = all(captured, "/api/ingest/traces", "traces");
    expect(trace.spans.map((s: any) => s.name)).toContain("cache.get");
    const [row] = all(captured, "/api/ingest/requests", "requests");
    expect(row.queryParams).toEqual({ signature: "***", page: "2" });
  });

  test("a thrown error is recorded and rethrown", async () => {
    const fetchHandler = sentrinelBunMiddleware(baseOptions(uniqueApp("bun")), () => {
      throw new Error("db down");
    });
    await expect(fetchHandler(new Request("http://api.test/x"), null)).rejects.toThrow("db down");
    await fetchHandler.flush();
    expect(all(captured, "/api/ingest/errors", "errors")[0].stackTrace).toContain("db down");
  });
});
