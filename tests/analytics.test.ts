// Product-event capture in the browser SDK. The cases that matter are the ones
// that silently produce wrong numbers rather than errors: a returning visitor
// counted as new, an SPA counted as one page, and a route re-render counted as
// a second visit.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  initSentrinelBrowser,
  resetSentrinelBrowser,
  loadAnonymousId,
} from "../src/browser";

/** Batches the fake endpoint received. */
let sent: any[] = [];

function installDom() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(e: any) => void>>();

  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as any).location = {
    pathname: "/",
    search: "",
    href: "https://app.test/",
    origin: "https://app.test",
  };
  (globalThis as any).document = { referrer: "", addEventListener() {}, removeEventListener() {} };
  (globalThis as any).history = {
    pushState() {},
    replaceState() {},
  };
  (globalThis as any).window = {
    addEventListener: (name: string, fn: (e: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener: (name: string, fn: (e: any) => void) => listeners.get(name)?.delete(fn),
    dispatch: (name: string) => listeners.get(name)?.forEach((fn) => fn({})),
    location: (globalThis as any).location,
  };
  (globalThis as any).navigator = { userAgent: "test", sendBeacon: undefined };
  return { store, window: (globalThis as any).window };
}

function fakeFetch() {
  return async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 202 });
  };
}

let dom: ReturnType<typeof installDom>;

beforeEach(() => {
  sent = [];
  dom = installDom();
  (globalThis as any).fetch = fakeFetch();
  resetSentrinelBrowser();
});

afterEach(() => {
  resetSentrinelBrowser();
});

function boot(options: Record<string, unknown> = {}) {
  return initSentrinelBrowser({
    endpoint: "/api/_sentrinel",
    captureErrors: false,
    captureRequests: false,
    captureBreadcrumbs: false,
    ...options,
  });
}

describe("device identity", () => {
  it("keeps the same id across sessions, so returning users are recognisable", () => {
    // Without persistence every visit is a new user and "returning" is
    // permanently zero — a wrong number that looks like a real one.
    const first = loadAnonymousId();
    const second = loadAnonymousId();
    expect(first).toBe(second);
    expect(first).toMatch(/^anon_/);
  });

  it("falls back to a fresh id when storage is unavailable", () => {
    // Private mode and embedded webviews throw on localStorage. Degrading to
    // per-session identity beats throwing inside someone's app.
    const saved = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(loadAnonymousId()).toMatch(/^anon_/);
    (globalThis as any).localStorage = saved;
  });

  it("replaces a corrupted stored id rather than sending junk", () => {
    dom.store.set("sentrinel_anonymous_id", "<script>");
    expect(loadAnonymousId()).toMatch(/^anon_[A-Za-z0-9_-]+$/);
  });
});

describe("track", () => {
  it("buffers an event and sends it with the batch", async () => {
    const s = boot({ autoPageviews: false });
    s.track("checkout_started", { plan: "pro" });
    await s.flush();

    const events = sent.flatMap((b) => b.events ?? []);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("track");
    expect(events[0].name).toBe("checkout_started");
    expect(events[0].properties).toEqual({ plan: "pro" });
  });

  it("carries the device id so the event has an owner", async () => {
    const s = boot({ autoPageviews: false });
    s.track("thing");
    await s.flush();
    expect(sent[0].anonymousId).toMatch(/^anon_/);
  });

  it("ignores a nameless event rather than storing a blank row", async () => {
    const s = boot({ autoPageviews: false });
    s.track("");
    s.track(null as unknown as string);
    await s.flush();
    expect(sent.flatMap((b) => b.events ?? [])).toHaveLength(0);
  });

  it("bounds a hostile event name, without altering the key", async () => {
    // A hard slice: a "… [truncated]" suffix would change the grouping key and
    // then show up as part of the name in every chart.
    const s = boot({ autoPageviews: false });
    s.track("x".repeat(5000));
    await s.flush();
    expect(sent[0].events[0].name).toBe("x".repeat(200));
  });
});

describe("identify", () => {
  it("emits a link once when the user becomes known", async () => {
    // This is what lets pre-login activity be attributed after signup.
    const s = boot({ autoPageviews: false });
    s.setUser("user_42");
    await s.flush();

    const identifies = sent.flatMap((b) => b.events ?? []).filter((e: any) => e.kind === "identify");
    expect(identifies).toHaveLength(1);
    expect(identifies[0].userId).toBe("user_42");
    expect(identifies[0].anonymousId).toMatch(/^anon_/);
  });

  it("does not re-emit for the same user on every render", async () => {
    // SPAs call setUser on each route render; one link per login is enough.
    const s = boot({ autoPageviews: false });
    s.setUser("user_42");
    s.setUser("user_42");
    s.setUser("user_42");
    await s.flush();

    const identifies = sent.flatMap((b) => b.events ?? []).filter((e: any) => e.kind === "identify");
    expect(identifies).toHaveLength(1);
  });

  it("emits again when a different person signs in", async () => {
    const s = boot({ autoPageviews: false });
    s.setUser("user_1");
    s.setUser("user_2");
    await s.flush();

    const identifies = sent.flatMap((b) => b.events ?? []).filter((e: any) => e.kind === "identify");
    expect(identifies.map((e: any) => e.userId)).toEqual(["user_1", "user_2"]);
  });
});

describe("pageviews", () => {
  it("records the initial load", async () => {
    const s = boot();
    await s.flush();
    const views = sent.flatMap((b) => b.events ?? []).filter((e: any) => e.kind === "pageview");
    expect(views).toHaveLength(1);
  });

  it("records an SPA route change with no navigation", async () => {
    // A pageview count that only counts hard loads reports a single-page app
    // as a single page.
    const s = boot();
    (globalThis as any).location.pathname = "/checkout";
    (globalThis as any).window.dispatch("popstate");
    await s.flush();

    const names = sent
      .flatMap((b) => b.events ?? [])
      .filter((e: any) => e.kind === "pageview")
      .map((e: any) => e.name);
    expect(names).toContain("/checkout");
  });

  it("does not double-count a re-render of the same route", async () => {
    const s = boot();
    (globalThis as any).location.pathname = "/checkout";
    (globalThis as any).window.dispatch("popstate");
    (globalThis as any).window.dispatch("popstate");
    (globalThis as any).window.dispatch("popstate");
    await s.flush();

    const views = sent
      .flatMap((b) => b.events ?? [])
      .filter((e: any) => e.kind === "pageview" && e.name === "/checkout");
    expect(views).toHaveLength(1);
  });

  it("can be turned off", async () => {
    const s = boot({ autoPageviews: false });
    await s.flush();
    expect(sent.flatMap((b) => b.events ?? [])).toHaveLength(0);
  });

  it("records an explicit virtual page", async () => {
    const s = boot({ autoPageviews: false });
    s.page("/wizard/step-2");
    await s.flush();
    expect(sent[0].events[0].name).toBe("/wizard/step-2");
  });
});

describe("no-op on the server", () => {
  it("returns a handle that does nothing rather than throwing", () => {
    // The same module gets imported from code that runs on both sides.
    const saved = (globalThis as any).window;
    delete (globalThis as any).window;
    resetSentrinelBrowser();

    const s = initSentrinelBrowser({ endpoint: "/x" });
    expect(s.enabled).toBe(false);
    expect(() => s.track("x")).not.toThrow();
    expect(() => s.page("/y")).not.toThrow();

    (globalThis as any).window = saved;
  });
});
