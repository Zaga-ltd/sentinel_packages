import { describe, expect, it, beforeEach, mock, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { sentrinelPlugin } from "../src/index";
import { all, installCapture } from "./helpers/capture";

describe("Sentrinel Plugin", () => {
  beforeEach(() => {
    // Reset any mocks or state if necessary
  });

  it("should initialize with default config", async () => {
    const app = new Elysia().use(
      sentrinelPlugin({
        appName: "test-app",
        apiKey: "test-api-key",
        serverUrl: "http://localhost:3001",
      })
    );

    expect(app).toBeDefined();
  });

  it("should collect metrics on request", async () => {
    const app = new Elysia()
      .use(
        sentrinelPlugin({
          appName: "test-app",
          apiKey: "test-api-key",
          serverUrl: "http://localhost:3001",
        })
      )
      .get("/hello", () => "world");

    const req = new Request("http://localhost/hello");
    const res = await app.handle(req);
    
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("world");
    // Since metric collection is buffered and asynchronous in the plugin,
    // we primarily test that the plugin doesn't break the application flow here.
  });

  it("should mask sensitive data when configured", async () => {
    const app = new Elysia()
      .use(
        sentrinelPlugin({
          appName: "test-app",
          apiKey: "test-api-key",
          serverUrl: "http://localhost:3001",
          requestLogging: {
            enabled: true,
            maskQueryParams: [/^password$/i],
            maskHeaders: [/^authorization$/i],
          }
        })
      )
      .post("/auth", (ctx) => "ok");

    const req = new Request("http://localhost/auth?password=secret", {
      method: "POST",
      headers: {
        "Authorization": "Bearer secret-token"
      }
    });

    const res = await app.handle(req);
    expect(res.status).toBe(200);
  });

  // A handler that returns a Response carries its own status. `set.status`
  // stays at its default 200 in that case, and preferring it recorded every
  // such error as a success.
  it("records a returned Response's status, not set.status", async () => {
    const cap = installCapture();
    try {
      const app = new Elysia()
        .use(sentrinelPlugin({ serverUrl: "http://s.test", appName: "status-test", env: "test", flushInterval: 40 }))
        .get("/gone", () => new Response("gone", { status: 410 }));
      const res = await app.handle(new Request("http://local/gone"));
      expect(res.status).toBe(410);
      await Bun.sleep(150);
      const [endpoint] = all(cap.captured, "/api/ingest/metrics", "endpoints");
      expect(endpoint.statusCodes).toEqual({ "410": 1 });
      expect(all(cap.captured, "/api/ingest/errors", "errors")[0].statusCode).toBe(410);
    } finally {
      cap.restore();
    }
  });

  it("masks credentials in logged headers and query strings with no patterns configured", async () => {
    const cap = installCapture();
    try {
      const app = new Elysia()
        .use(
          sentrinelPlugin({
            serverUrl: "http://s.test",
            appName: "mask-default",
            env: "test",
            flushInterval: 40,
            requestLogging: { enabled: true, logRequestHeaders: true },
          })
        )
        .get("/r", () => "ok");
      await app.handle(
        new Request("http://local/r?token=abc&page=1", { headers: { authorization: "Bearer x", cookie: "s=1" } })
      );
      await Bun.sleep(150);
      const [row] = all(cap.captured, "/api/ingest/requests", "requests");
      expect(row.requestHeaders.authorization).toBe("***");
      expect(row.requestHeaders.cookie).toBe("***");
      expect(row.queryParams).toEqual({ token: "***", page: "1" });
    } finally {
      cap.restore();
    }
  });
});
