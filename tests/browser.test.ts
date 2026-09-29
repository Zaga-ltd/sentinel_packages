/**
 * Browser SDK and tunnel.
 *
 * There is no jsdom here, so the tests build the smallest `window`/`document`
 * that the SDK actually touches. That is deliberate: it keeps the surface the
 * SDK depends on visible and small, and a test that fails because the SDK
 * reached for something new is useful information.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createSentrinelTunnel } from "../src/tunnel";

// ─── A minimal DOM ──────────────────────────────────────────────────────────

interface Listener {
  type: string;
  fn: (event: any) => void;
}

/** Routes are consulted by the base fetch, so a test can make a call fail
 *  without replacing `window.fetch` — replacing it would remove the SDK's own
 *  patch and the test would quietly stop testing anything. */
type Routes = Record<string, () => Promise<Response>>;

function installDom(): {
  fire: (type: string, event: any) => void;
  sent: any[];
  routes: Routes;
} {
  const listeners: Listener[] = [];
  const docListeners: Listener[] = [];
  const sent: any[] = [];
  const routes: Routes = {};

  const target = (list: Listener[]) => ({
    addEventListener: (type: string, fn: any) => list.push({ type, fn }),
    removeEventListener: (type: string, fn: any) => {
      const i = list.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) list.splice(i, 1);
    },
  });

  const history = {
    pushState: () => {},
    replaceState: () => {},
  };

  (globalThis as any).location = {
    href: "https://admin.example.com/dashboard",
    origin: "https://admin.example.com",
    pathname: "/dashboard",
  };
  (globalThis as any).window = {
    ...target(listeners),
    history,
    fetch: async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      for (const [pattern, handler] of Object.entries(routes)) {
        if (String(url).includes(pattern)) return handler();
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
    },
  };
  (globalThis as any).document = {
    ...target(docListeners),
    visibilityState: "visible",
  };
  (globalThis as any).navigator = {
    language: "en-GB",
    userAgent: "test",
    hardwareConcurrency: 8,
  };
  (globalThis as any).screen = { width: 1440, height: 900 };

  return {
    sent,
    routes,
    fire: (type, event) => {
      for (const l of [...listeners, ...docListeners]) if (l.type === type) l.fn(event);
    },
  };
}

function clearDom(): void {
  for (const key of ["window", "document", "navigator", "location", "screen"]) {
    delete (globalThis as any)[key];
  }
}

/** Imported fresh each time, because the SDK holds a module-level singleton. */
async function freshSdk() {
  const mod = await import(`../src/browser?t=${Math.random()}`);
  return mod as typeof import("../src/browser");
}

// ─── SSR ────────────────────────────────────────────────────────────────────

describe("browser SDK — server rendering", () => {
  afterEach(clearDom);

  test("returns a no-op instead of throwing when there is no window", async () => {
    clearDom();
    const { initSentrinelBrowser } = await freshSdk();
    const sentrinel = initSentrinelBrowser({ release: "1.0.0" });

    expect(sentrinel.enabled).toBe(false);
    // Every method must be safe to call — the same module is imported by code
    // that runs on both sides.
    expect(() => sentrinel.captureError(new Error("boom"))).not.toThrow();
    expect(() => sentrinel.addBreadcrumb("hi")).not.toThrow();
    expect(() => sentrinel.setUser("u1")).not.toThrow();
    await sentrinel.flush();
  });
});

// ─── Capture ────────────────────────────────────────────────────────────────

describe("browser SDK — capture", () => {
  let dom: ReturnType<typeof installDom>;
  let sdk: typeof import("../src/browser");

  beforeEach(async () => {
    dom = installDom();
    sdk = await freshSdk();
  });
  afterEach(clearDom);

  test("an uncaught error is recorded and marks the session crashed", async () => {
    const s = sdk.initSentrinelBrowser({ release: "2.0.0", flushInterval: 1_000_000 });
    dom.fire("error", { error: new TypeError("cannot read x"), filename: "app.js", lineno: 4 });
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0].errorType).toBe("TypeError");
    expect(batch.errors[0].errorMessage).toBe("cannot read x");
    expect(batch.errors[0].attributes["error.handled"]).toBe(false);
    expect(batch.errors[0].path).toBe("/dashboard");
    expect(batch.sessions[0].status).toBe("crashed");
  });

  test("a handled error marks the session errored, not crashed", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    s.captureError(new Error("recovered"), { orderId: "o1" });
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors[0].attributes["error.handled"]).toBe(true);
    expect(batch.errors[0].attributes.orderId).toBe("o1");
    expect(batch.sessions[0].status).toBe("errored");
  });

  test("session status only ever rises", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    dom.fire("error", { error: new Error("fatal") });
    // A handled error afterwards must not downgrade a crash to `errored` — the
    // release's number should not depend on the order two events arrived in.
    s.captureError(new Error("minor"));
    await s.flush();

    expect(JSON.parse(dom.sent.at(-1)!.init.body).sessions[0].status).toBe("crashed");
  });

  test("unhandled promise rejections are captured", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    dom.fire("unhandledrejection", { reason: new Error("no network") });
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors[0].errorMessage).toBe("no network");
    expect(batch.errors[0].attributes["error.mechanism"]).toBe("unhandledrejection");
  });

  test("known browser noise is dropped", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    // Opaque cross-origin failure — no message, no file, nothing to act on.
    dom.fire("error", { error: "Script error.", filename: "" });
    dom.fire("error", { error: "ResizeObserver loop limit exceeded" });
    await s.flush();

    // Only the session is sent; there were no reportable errors.
    const batch = dom.sent.length ? JSON.parse(dom.sent.at(-1)!.init.body) : { errors: [] };
    expect(batch.errors).toHaveLength(0);
  });

  test("custom ignore patterns are honoured", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000, ignoreErrors: [/ResizeObserver/, "AbortError"] });
    s.captureError(new Error("AbortError: user cancelled"));
    s.captureError(new Error("real problem"));
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0].errorMessage).toBe("real problem");
  });

  test("breadcrumbs ride along with the error, oldest first and capped", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    for (let i = 0; i < 40; i++) s.addBreadcrumb(`step ${i}`, { category: "ui" });
    s.captureError(new Error("after 40 steps"));
    await s.flush();

    const trail = JSON.parse(dom.sent.at(-1)!.init.body).errors[0].attributes.breadcrumbs;
    expect(trail).toHaveLength(25);
    expect(trail[0].message).toBe("step 15");
    expect(trail.at(-1).message).toBe("step 39");
  });

  test("beforeSend can drop a record entirely", async () => {
    const s = sdk.initSentrinelBrowser({
      flushInterval: 1_000_000,
      beforeSend: (r) => (r.kind === "error" && r.errorMessage?.includes("secret") ? null : r),
    });
    s.captureError(new Error("contains a secret"));
    s.captureError(new Error("safe to send"));
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0].errorMessage).toBe("safe to send");
  });

  test("a throwing beforeSend does not swallow the error it was inspecting", async () => {
    const s = sdk.initSentrinelBrowser({
      flushInterval: 1_000_000,
      beforeSend: () => {
        throw new Error("hook is broken");
      },
    });
    s.captureError(new Error("still reported"));
    await s.flush();

    expect(JSON.parse(dom.sent.at(-1)!.init.body).errors[0].errorMessage).toBe("still reported");
  });

  test("setUser attributes errors to a consumer", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    s.setUser("user_42");
    s.captureError(new Error("theirs"));
    await s.flush();

    expect(JSON.parse(dom.sent.at(-1)!.init.body).errors[0].consumerIdentifier).toBe("user_42");
  });
});

// ─── Requests and the trace join ────────────────────────────────────────────

describe("browser SDK — requests", () => {
  let dom: ReturnType<typeof installDom>;
  let sdk: typeof import("../src/browser");

  beforeEach(async () => {
    dom = installDom();
    sdk = await freshSdk();
  });
  afterEach(clearDom);

  test("same-origin calls carry traceparent, so the backend continues the trace", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    await (globalThis as any).window.fetch("/api/orders", { method: "GET" });

    const call = dom.sent.find((c) => c.url === "/api/orders")!;
    const header = new Headers(call.init.headers).get("traceparent")!;
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await s.flush();
    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    // The recorded traceId must be the one that was actually sent, or the two
    // halves never join up.
    expect(header).toContain(batch.requests[0].traceId);
  });

  test("third-party calls are not given trace headers", async () => {
    sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    await (globalThis as any).window.fetch("https://analytics.vendor.com/collect", { method: "POST" });

    const call = dom.sent.find((c) => c.url.includes("vendor.com"))!;
    expect(new Headers(call.init?.headers ?? {}).get("traceparent")).toBeNull();
  });

  test("a caller's own traceparent wins", async () => {
    sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    const mine = "00-11111111111111111111111111111111-2222222222222222-01";
    await (globalThis as any).window.fetch("/api/orders", { headers: { traceparent: mine } });

    const call = dom.sent.find((c) => c.url === "/api/orders")!;
    expect(new Headers(call.init.headers).get("traceparent")).toBe(mine);
  });

  test("a network failure is recorded with status 0 and rethrown", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    dom.routes["/api/orders"] = () => Promise.reject(new Error("Failed to fetch"));

    await expect((globalThis as any).window.fetch("/api/orders")).rejects.toThrow("Failed to fetch");
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    const req = batch.requests.find((r: any) => r.path === "/api/orders");
    // Nothing reached a server, so there is no status. 0 says "did not
    // complete" rather than inventing a 5xx nobody sent.
    expect(req.statusCode).toBe(0);
    expect(req.errorMessage).toBe("Failed to fetch");

    // A transport failure is also an error, linked back to its request.
    const err = batch.errors.find((e: any) => e.errorType === "NetworkError");
    expect(err.requestLogId).toBe(req.id);
    expect(err.traceId).toBe(req.traceId);
  });

  test("the SDK's own batches are never recorded as requests", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000, endpoint: "/api/_sentrinel" });
    s.captureError(new Error("one"));
    await s.flush();
    await s.flush();

    const batches = dom.sent.filter((c) => c.url === "/api/_sentrinel");
    for (const b of batches) {
      const parsed = JSON.parse(b.init.body);
      // If the flush POST were recorded, the next batch would contain it — and
      // each flush would generate the next one, forever.
      expect(parsed.requests.some((r: any) => r.path === "/api/_sentrinel")).toBe(false);
    }
  });

  test("failing requests survive sampling", async () => {
    // sampleRate 0 means "keep nothing" — except the records anyone actually
    // opens the page for.
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000, sampleRate: 0 });
    dom.routes["/api/broken"] = async () => new Response("no", { status: 500 });

    await (globalThis as any).window.fetch("/api/ok");
    await (globalThis as any).window.fetch("/api/broken");
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    const paths = batch.requests.map((r: any) => r.path);
    expect(paths).toContain("/api/broken");
    expect(paths).not.toContain("/api/ok");
    expect(batch.requests.find((r: any) => r.path === "/api/broken").sampleRate).toBe(1);
  });

  test("slow requests survive sampling too", async () => {
    const s = sdk.initSentrinelBrowser({
      flushInterval: 1_000_000,
      sampleRate: 0,
      slowRequestThresholdMs: 0, // everything counts as slow
    });
    await (globalThis as any).window.fetch("/api/slow");
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.requests.map((r: any) => r.path)).toContain("/api/slow");
  });

  test("init twice returns the same client rather than double-patching fetch", async () => {
    const first = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    const patchedOnce = (globalThis as any).window.fetch;
    const second = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });

    expect(second).toBe(first);
    expect((globalThis as any).window.fetch).toBe(patchedOnce);
  });

  test("close unpatches fetch and ends the session", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    const patched = (globalThis as any).window.fetch;
    await s.close();

    expect((globalThis as any).window.fetch).not.toBe(patched);
    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.sessions[0].endedAt).toBeTruthy();
  });
});

// ─── Delivery, privacy and identity ─────────────────────────────────────────

describe("browser SDK — delivery", () => {
  let dom: ReturnType<typeof installDom>;
  let sdk: typeof import("../src/browser");

  beforeEach(async () => {
    dom = installDom();
    sdk = await freshSdk();
  });
  afterEach(clearDom);

  const batchesTo = (path: string) =>
    dom.sent.filter((c) => c.url === path).map((c) => JSON.parse(c.init.body));

  test("posts to /api/sentrinel by default — a path Next's App Router can serve", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    s.captureError(new Error("x"));
    await s.flush();
    expect(batchesTo("/api/sentrinel")).toHaveLength(1);
  });

  test("a failed batch is kept and resent, not lost", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      let calls = 0;
      dom.routes["/api/sentrinel"] = async () =>
        ++calls === 1 ? new Response("down", { status: 503 }) : new Response("{}", { status: 202 });
      const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
      s.captureError(new Error("survives an outage"));
      await s.flush();

      // Held with backoff; skip the wait.
      (s as any).outbox.forEach((p: any) => (p.nextAt = 0));
      await s.flush();

      const [, ...after] = batchesTo("/api/sentrinel");
      expect(after.flatMap((b) => b.errors).map((e: any) => e.errorMessage)).toEqual(["survives an outage"]);
      // The session state that failed with the first batch is sent again —
      // current, not the stale snapshot the failed batch carried.
      const sessions = after.flatMap((b) => b.sessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("errored");
    } finally {
      console.warn = warn;
    }
  });

  test("a batch refused as malformed is not retried forever", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      dom.routes["/api/sentrinel"] = async () => new Response("bad", { status: 400 });
      const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
      s.captureError(new Error("x"));
      await s.flush();
      expect((s as any).outbox).toHaveLength(0);
    } finally {
      console.warn = warn;
    }
  });

  test("close() leaves history exactly as it found it", async () => {
    const history = (globalThis as any).window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    (globalThis as any).history = history;
    try {
      const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
      expect(history.pushState).not.toBe(push);
      await s.close();
      // Both the pageview and the breadcrumb wrappers are gone, in that order.
      expect(history.pushState).toBe(push);
      expect(history.replaceState).toBe(replace);
    } finally {
      delete (globalThis as any).history;
    }
  });
});

describe("browser SDK — URLs are masked", () => {
  let dom: ReturnType<typeof installDom>;
  let sdk: typeof import("../src/browser");

  beforeEach(async () => {
    dom = installDom();
    Object.assign((globalThis as any).location, {
      href: "https://admin.example.com/reset?token=abc123&step=2",
      pathname: "/reset",
      search: "?token=abc123&step=2",
    });
    sdk = await freshSdk();
  });
  afterEach(clearDom);

  test("in request records, error records and pageviews", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    await (globalThis as any).window.fetch("/api/files?X-Amz-Signature=sig&api_key=k&v=1");
    s.captureError(new Error("boom"));
    // This DOM has no global `history`, so no automatic pageview; ask for one.
    s.page();
    await s.flush();

    const body = JSON.stringify(dom.sent.filter((c) => c.url === "/api/sentrinel").map((c) => c.init.body));
    for (const secret of ["abc123", "sig&", "api_key=k"]) expect(body).not.toContain(secret);

    const batch = JSON.parse(dom.sent.find((c) => c.url === "/api/sentrinel")!.init.body);
    const req = batch.requests.find((r: any) => r.path === "/api/files");
    expect(req.queryParams).toEqual({ "X-Amz-Signature": "***", api_key: "***", v: "1" });
    expect(req.attributes["http.url"]).toBe("/api/files?X-Amz-Signature=***&api_key=***&v=1");
    expect(batch.errors[0].attributes["browser.url"]).toBe("https://admin.example.com/reset?token=***&step=2");
    const pageview = batch.events.find((e: any) => e.kind === "pageview");
    expect(pageview.name).toBe("/reset?token=***&step=2");
  });
});

describe("browser SDK — device identity", () => {
  let dom: ReturnType<typeof installDom>;
  let sdk: typeof import("../src/browser");

  beforeEach(async () => {
    dom = installDom();
    sdk = await freshSdk();
  });
  afterEach(clearDom);

  test("signed-out records belong to guest:<device>, identify switches, identify(null) goes back", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    const guest = `guest:${s.deviceId}`;
    expect(s.consumer).toBe(guest);

    s.captureError(new Error("before login"));
    s.identify("user_7");
    s.captureError(new Error("after login"));
    s.identify(null);
    s.captureError(new Error("after logout"));
    await s.flush();

    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    expect(batch.errors.map((e: any) => e.consumerIdentifier)).toEqual([guest, "user_7", guest]);
    expect(batch.errors.every((e: any) => e.attributes["device.id"] === s.deviceId)).toBe(true);
    expect(batch.sessions[0].attributes["device.id"]).toBe(s.deviceId);
    // The link from this device's history to the person.
    const identify = batch.events.find((e: any) => e.kind === "identify");
    expect(identify).toMatchObject({ anonymousId: s.deviceId, userId: "user_7" });
  });

  test("consumer and device headers go to your own origin, never to a third party", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    await (globalThis as any).window.fetch("/api/orders");
    await (globalThis as any).window.fetch("https://analytics.vendor.com/collect");

    const own = new Headers(dom.sent.find((c) => c.url === "/api/orders")!.init.headers);
    expect(own.get("x-sentrinel-consumer")).toBe(`guest:${s.deviceId}`);
    expect(own.get("x-sentrinel-device")).toBe(s.deviceId);

    const vendor = new Headers(dom.sent.find((c) => c.url.includes("vendor.com"))!.init?.headers ?? {});
    expect(vendor.get("x-sentrinel-consumer")).toBeNull();
    expect(vendor.get("x-sentrinel-device")).toBeNull();

    await s.flush();
    const batch = JSON.parse(dom.sent.at(-1)!.init.body);
    const third = batch.requests.find((r: any) => r.attributes["http.host"] === "analytics.vendor.com");
    expect(third.attributes["sentrinel.third_party"]).toBe(true);
    const mine = batch.requests.find((r: any) => r.path === "/api/orders");
    expect(mine.attributes["sentrinel.third_party"]).toBeUndefined();
    expect(mine.attributes["sentrinel.kind"]).toBe("client");
  });

  test("a user id that cannot be a header value never breaks the app's fetch", async () => {
    const s = sdk.initSentrinelBrowser({ flushInterval: 1_000_000 });
    s.identify("Zoë");
    const res = await (globalThis as any).window.fetch("/api/orders");
    expect(res.status).toBe(202);
  });
});

describe("rollup", () => {
  test("weights sampled records by 1/sampleRate and skips third-party calls", async () => {
    const { rollUpEndpoints } = await import("../src/rollup");
    const [x] = rollUpEndpoints([
      // Nine healthy requests kept at 10% stand for ninety.
      ...Array.from({ length: 9 }, () => ({ method: "GET", path: "/x", statusCode: 200, responseTime: 10, sampleRate: 0.1 })),
      // Errors are always kept, at rate 1.
      { method: "GET", path: "/x", statusCode: 500, responseTime: 900, sampleRate: 1 },
      { method: "GET", path: "/cdn", statusCode: 200, responseTime: 5, attributes: { "sentrinel.third_party": true } },
    ]);
    expect(x.requestCount).toBe(91);
    expect(x.errorCount).toBe(1);
    // Unweighted, the one error would drag p50 into it; weighted it is noise.
    expect(x.p50ResponseTime).toBe(10);
    expect(rollUpEndpoints([{ method: "GET", path: "/cdn", statusCode: 200, responseTime: 5, attributes: { "sentrinel.third_party": true } }])).toHaveLength(0);
  });
});

test("the tunnel answers on both the new and the old path", async () => {
  const { isSentrinelTunnelPath } = await import("../src/tunnel");
  expect(isSentrinelTunnelPath("/api/sentrinel")).toBe(true);
  expect(isSentrinelTunnelPath("/api/_sentrinel")).toBe(true);
  expect(isSentrinelTunnelPath("/api/sentrinel/")).toBe(true);
  expect(isSentrinelTunnelPath("/api/other")).toBe(false);
});

// ─── Tunnel ─────────────────────────────────────────────────────────────────

describe("tunnel", () => {
  const captured: { url: string; body: any; key: string | null }[] = [];
  let restore: typeof fetch;

  beforeEach(() => {
    captured.length = 0;
    restore = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      captured.push({
        url: String(url),
        body: JSON.parse(init.body),
        key: new Headers(init.headers).get("x-api-key"),
      });
      return new Response("{}", { status: 200 });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = restore;
  });

  const opts = {
    serverUrl: "https://api.sentrinel.dev",
    appName: "admin",
    env: "prod",
    apiKey: "snt_live_secret",
  };

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://admin.example.com/api/_sentrinel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("forwards each record type to its ingest endpoint with the key", async () => {
    const tunnel = createSentrinelTunnel(opts);
    const res = await tunnel(
      post({
        errors: [{ method: "BROWSER", path: "/x", statusCode: 0 }],
        requests: [{ id: "r1", method: "GET", path: "/api/x", statusCode: 200 }],
        sessions: [{ sessionId: "s1", status: "ok" }],
      })
    );

    expect(res.status).toBe(202);
    // `accepted` counts the records the page sent, not the requests made of
    // the API.
    expect(await res.json()).toEqual({ accepted: 3 });
    expect(captured.map((c) => c.url).sort()).toEqual([
      "https://api.sentrinel.dev/api/ingest/errors",
      "https://api.sentrinel.dev/api/ingest/requests",
      "https://api.sentrinel.dev/api/ingest/sessions",
    ]);
    expect(captured.every((c) => c.key === "snt_live_secret")).toBe(true);
    // The browser is its own module of the app, whatever key the tunnel holds.
    expect(captured.every((c) => c.body.module === "web")).toBe(true);
  });

  // Browser timings used to be rolled up into /api/ingest/metrics, landing in
  // the same endpoint rows as the backend's — every call counted twice, and a
  // p95 that blended the network into the server's number.
  test("browser timings never reach the backend's endpoint rollup; rows are marked client", async () => {
    const tunnel = createSentrinelTunnel(opts);
    await tunnel(
      post({
        requests: [
          { id: "r1", method: "GET", path: "/api/x", statusCode: 200, responseTime: 10 },
          { id: "r2", method: "GET", path: "/api/x", statusCode: 500, responseTime: 30 },
        ],
      })
    );

    expect(captured.find((c) => c.url.endsWith("/api/ingest/metrics"))).toBeUndefined();
    const rows = captured.find((c) => c.url.endsWith("/api/ingest/requests"))!.body.requests as any[];
    expect(rows.every((r) => r.kind === "client" && r.attributes["sentrinel.kind"] === "client")).toBe(true);
  });

  test("request rows credit the server-resolved consumer, not the page's claim", async () => {
    // Same rule as sessions: a page can assert any identity, so the tunnel's
    // own answer has to win here too or the Consumers table is forgeable.
    const tunnel = createSentrinelTunnel({
      ...opts,
      consumerIdentifier: (req) => req.headers.get("x-user") ?? undefined,
    });
    await tunnel(
      post(
        {
          requests: [
            {
              id: "r1",
              method: "GET",
              path: "/api/x",
              statusCode: 200,
              responseTime: 10,
              consumerIdentifier: "i-say-i-am-admin",
            },
          ],
        },
        { "x-user": "real-user-42" }
      )
    );

    const rows = captured.find((c) => c.url.endsWith("/api/ingest/requests"))!.body.requests as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].consumerIdentifier).toBe("real-user-42");
  });

  test("a call the page propagated becomes the client span its trace starts with", async () => {
    const tunnel = createSentrinelTunnel(opts);
    const traceId = "a".repeat(32);
    await tunnel(
      post({
        requests: [
          { id: "r1", method: "POST", path: "/api/v1/jobs/1/complete", statusCode: 200, responseTime: 42,
            timestamp: new Date().toISOString(), traceId, spanId: "b".repeat(16) },
          // Not propagated (no spanId): nothing for the backend to continue.
          { id: "r2", method: "GET", path: "/cdn/logo.svg", statusCode: 200, responseTime: 3,
            timestamp: new Date().toISOString(), traceId: "c".repeat(32) },
        ],
      })
    );

    // One batched call, however many spans.
    const calls = captured.filter((c) => c.url.endsWith("/api/ingest/traces"));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.appName).toBe("admin");
    const traces = calls[0].body.traces as any[];
    expect(traces).toHaveLength(1);
    expect(traces[0].traceId).toBe(traceId);
    const [span] = traces[0].spans as any[];
    // The id the backend's span names as its parent, or the two never join.
    expect(span.id).toBe("b".repeat(16));
    expect(span.kind).toBe("CLIENT");
    expect(span.attributes["sentrinel.source"]).toBe("browser");
  });

  test("appName and env come from the server, never the browser", async () => {
    const tunnel = createSentrinelTunnel(opts);
    // A hostile page claiming to be someone else's app.
    await tunnel(
      post({
        appName: "someone-elses-app",
        env: "staging",
        errors: [{ method: "BROWSER", path: "/x", statusCode: 0 }],
      } as any)
    );

    expect(captured[0].body.appName).toBe("admin");
    expect(captured[0].body.env).toBe("prod");
  });

  test("consumerIdentifier overrides whatever the browser claimed", async () => {
    const tunnel = createSentrinelTunnel({
      ...opts,
      consumerIdentifier: (req) => req.headers.get("x-user") ?? undefined,
    });
    await tunnel(
      post({ errors: [{ method: "BROWSER", path: "/x", consumerIdentifier: "admin_root" }] }, { "x-user": "user_9" })
    );

    // Identity is asserted by the server session, not by the page.
    expect(captured[0].body.errors[0].consumerIdentifier).toBe("user_9");
  });

  test("a throwing consumerIdentifier costs the consumer, not the batch", async () => {
    const tunnel = createSentrinelTunnel({
      ...opts,
      consumerIdentifier: () => {
        throw new Error("session store down");
      },
    });
    const res = await tunnel(post({ errors: [{ method: "BROWSER", path: "/x" }] }));

    expect(res.status).toBe(202);
    expect(captured[0].body.errors).toHaveLength(1);
  });

  test("oversized batches are rejected before being buffered", async () => {
    const tunnel = createSentrinelTunnel({ ...opts, maxBodyBytes: 100 });
    const res = await tunnel(post({ errors: Array.from({ length: 50 }, () => ({ path: "/x" })) }));

    expect(res.status).toBe(413);
    expect(captured).toHaveLength(0);
  });

  test("malformed input is rejected, not forwarded", async () => {
    const tunnel = createSentrinelTunnel(opts);
    const bad = new Request("https://admin.example.com/api/_sentrinel", {
      method: "POST",
      body: "not json",
    });

    expect((await tunnel(bad)).status).toBe(400);
    expect((await tunnel(new Request("https://admin.example.com/api/_sentrinel"))).status).toBe(405);
    expect(captured).toHaveLength(0);
  });

  test("non-object array entries are filtered out", async () => {
    const tunnel = createSentrinelTunnel(opts);
    await tunnel(post({ errors: ["nope", null, 42, { method: "BROWSER", path: "/x" }] }));

    expect(captured[0].body.errors).toHaveLength(1);
  });

  test("an unreachable Sentrinel still answers the page 202", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const tunnel = createSentrinelTunnel(opts);
    const res = await tunnel(post({ errors: [{ method: "BROWSER", path: "/x" }] }));

    // The page can do nothing with a delivery failure, and a failed request in
    // its console is noise about monitoring in place of its own signal.
    expect(res.status).toBe(202);
  });

  test("beforeForward can drop the whole batch", async () => {
    const tunnel = createSentrinelTunnel({ ...opts, beforeForward: () => null });
    const res = await tunnel(post({ errors: [{ method: "BROWSER", path: "/x" }] }));

    expect(res.status).toBe(202);
    expect(captured).toHaveLength(0);
  });

  test("release is stamped onto sessions that lack one", async () => {
    const tunnel = createSentrinelTunnel({ ...opts, release: "2026.8.2" });
    await tunnel(post({ sessions: [{ sessionId: "s1" }, { sessionId: "s2", release: "own" }] }));

    expect(captured[0].body.sessions[0].release).toBe("2026.8.2");
    expect(captured[0].body.sessions[1].release).toBe("own");
  });

  test("an empty batch sends nothing", async () => {
    const tunnel = createSentrinelTunnel(opts);
    const res = await tunnel(post({ errors: [], requests: [], sessions: [] }));

    expect(await res.json()).toEqual({ accepted: 0 });
    expect(captured).toHaveLength(0);
  });
});
