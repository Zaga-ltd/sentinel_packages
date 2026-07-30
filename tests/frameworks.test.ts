import { describe, expect, it } from "bun:test";
import { sentrinelExpressMiddleware } from "../src/express";
import { sentrinelNextMiddleware } from "../src/next";
import { createFlutterHeaderMap } from "../src/flutter";

describe("Multi-Framework Plugin Support", () => {
  it("generates valid W3C trace headers for Flutter Dio & http clients", () => {
    const headers = createFlutterHeaderMap("mobile_flutter_ios");
    expect(headers["x-consumer-id"]).toBe("mobile_flutter_ios");
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers["x-trace-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sentrinelNextMiddleware processes Next.js request and injects W3C headers", async () => {
    const middleware = sentrinelNextMiddleware({
      serverUrl: "http://localhost:3001",
      appName: "nextjs-app",
      env: "test",
    });

    const req = new Request("http://localhost:3000/api/v1/checkout", {
      headers: { "x-consumer-id": "web_react_client" },
    });

    const ctx = await middleware(req);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
    ctx.recordResponse(res);
  });

  it("sentrinelExpressMiddleware initializes express middleware function", () => {
    const mw = sentrinelExpressMiddleware({
      serverUrl: "http://localhost:3001",
      appName: "express-app",
      env: "test",
    });

    expect(typeof mw).toBe("function");
  });
});
