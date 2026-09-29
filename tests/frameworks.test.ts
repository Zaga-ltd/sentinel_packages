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

  it("sentrinelNextMiddleware passes every request through to its route", async () => {
    // The old middleware answered `new Response(null, { status: 200 })`, which
    // Next treats as the final response — every matched route came back blank.
    // A pass-through carries `x-middleware-next`, exactly as NextResponse.next().
    const middleware = sentrinelNextMiddleware({
      serverUrl: "http://localhost:3001",
      appName: "nextjs-app",
      env: "test",
    });

    const req = new Request("http://localhost:3000/api/v1/checkout");
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.body).toBeNull();

    // Old call sites still compile and do nothing harmful.
    middleware.recordResponse(req, new Response("{}"));
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
