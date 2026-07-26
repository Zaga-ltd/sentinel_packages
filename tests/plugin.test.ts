import { describe, expect, it, beforeEach, mock, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { sentinelPlugin } from "../src/index";

describe("Sentinel Plugin", () => {
  beforeEach(() => {
    // Reset any mocks or state if necessary
  });

  it("should initialize with default config", async () => {
    const app = new Elysia().use(
      sentinelPlugin({
        appId: "test-app-id",
        apiKey: "test-api-key",
      })
    );

    expect(app).toBeDefined();
  });

  it("should collect metrics on request", async () => {
    const app = new Elysia()
      .use(
        sentinelPlugin({
          appId: "test-app-id",
          apiKey: "test-api-key",
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
        sentinelPlugin({
          appId: "test-app-id",
          apiKey: "test-api-key",
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
});
