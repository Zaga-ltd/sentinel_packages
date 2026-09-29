// The client is the only thing in this package that holds the key, so these
// pin the two things that matter about it: where the key comes from, and that
// it never comes back out — not in a URL, not in an error.

import { describe, expect, test } from "bun:test";
import { configFromEnv, periodSeconds, retryAfter, SentrinelClient, SentrinelError } from "../src/client";

const KEY = "snt_mcp_0123456789abcdef";

function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("configuration", () => {
  test("requires both variables, and names the missing one", () => {
    expect(() => configFromEnv({})).toThrow(/SENTRINEL_API_URL/);
    expect(() => configFromEnv({ SENTRINEL_API_URL: "https://api.example" })).toThrow(/SENTRINEL_API_KEY/);
  });

  test("refuses every non-agent kind before making any request, naming it", () => {
    const cases: [string, RegExp][] = [
      ["snt_live_abc", /server/],
      ["snt_dev_abc", /server/],
      ["snt_mobile_abc", /mobile/],
      ["snt_db_abc", /database/],
      ["snt_otlp_abc", /OpenTelemetry/],
    ];
    for (const [bad, name] of cases) {
      expect(() => configFromEnv({ SENTRINEL_API_URL: "https://api.example", SENTRINEL_API_KEY: bad })).toThrow(name);
    }
  });

  test("refuses the documentation placeholder instead of failing at the network", () => {
    // snt_mcp_… has the right prefix and is not a key. Reaching fetch() it
    // fails as an invalid header value, which reads as "the API is down".
    for (const placeholder of ["snt_mcp_\u2026", "snt_mcprw_\u2026", "snt_mcp_"]) {
      expect(() =>
        configFromEnv({ SENTRINEL_API_URL: "https://api.example", SENTRINEL_API_KEY: placeholder })
      ).toThrow(/does not look like a key/);
    }
  });

  test("accepts both agent kinds and trims a trailing slash", () => {
    const cfg = configFromEnv({ SENTRINEL_API_URL: "https://api.example/", SENTRINEL_API_KEY: KEY });
    expect(cfg.url).toBe("https://api.example");
    expect(
      configFromEnv({ SENTRINEL_API_URL: "https://api.example", SENTRINEL_API_KEY: "snt_mcprw_0123456789abcdef" }).key
    ).toBe("snt_mcprw_0123456789abcdef");
  });
});

describe("the period a person writes", () => {
  // The API parses `period` with parseInt and treats it as seconds, so "7d"
  // arrives as SEVEN SECONDS — every query silently empty, no error anywhere.
  // That shipped, and the test that should have caught it inserted a row
  // milliseconds before querying, so a 7-second window contained it.
  test("a duration becomes seconds, not its first digits", () => {
    expect(periodSeconds("7d", 1)).toBe(604800);
    expect(periodSeconds("24h", 1)).toBe(86400);
    expect(periodSeconds("30m", 1)).toBe(1800);
    expect(periodSeconds("2w", 1)).toBe(1209600);
    expect(periodSeconds("90", 1)).toBe(90);
    expect(periodSeconds(3600, 1)).toBe(3600);
  });

  test("nonsense falls back rather than becoming a tiny window", () => {
    for (const bad of ["", "abc", "-5", "0", "7 days", undefined]) {
      expect(periodSeconds(bad as any, 604800)).toBe(604800);
    }
  });

  test("the wire always carries seconds", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { issues: [] });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    await client.listIssues({ period: "7d" });
    expect(calls[0].url).toContain("period=604800");
    expect(calls[0].url).not.toContain("period=7d");
  });

  test("sort is passed through so the list can answer a different question", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { issues: [] });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    await client.listIssues({ sort: "occurrences" });
    expect(calls[0].url).toContain("sort=occurrences");
  });
});

describe("requests", () => {
  test("sends the key as a bearer token, never in the URL", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { issues: [] });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    await client.listIssues({ search: "boom" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
    expect(url).toContain("/api/issues?");
    expect(url).toContain("status=unresolved");
    expect(url).toContain("period=604800"); // seconds on the wire, never "7d"
    expect(url).toContain("search=boom");
  });

  test("omits undefined and empty params so 'all' really means all", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { issues: [] });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    await client.listIssues({ status: "" });
    expect(calls[0].url).not.toContain("status=");
    expect(calls[0].url).not.toContain("search=");
  });

  test("a 401 says the key was rejected, and does not echo it", async () => {
    const { fetchImpl } = fakeFetch(401, { error: "Authentication required" });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    const err = await client.listIssues().catch((e) => e);
    expect(err).toBeInstanceOf(SentrinelError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/revoked/i);
    expect(err.message).not.toContain(KEY);
  });

  test("a 403 passes the server's reason through", async () => {
    const { fetchImpl } = fakeFetch(403, { error: "This is a read-only API key. Issue an \"AI agent — may resolve issues\" key to change issue status." });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    const err = await client.setIssueStatus("abc", "resolved").catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/read-only/);
  });

  test("an unreachable API is reported as such, with the URL", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    const err = await client.getIssue("x").catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toContain("https://api.example");
    expect(err.message).not.toContain(KEY);
  });

  test("status changes are a PATCH with a JSON body", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { ok: true });
    const client = new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl);
    await client.setIssueStatus("abc", "ignored");
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.example/api/issues/abc");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: "ignored" });
  });
});

describe("replies that are not the API's", () => {
  const client = (fetchImpl: typeof fetch, timeoutMs?: number) =>
    new SentrinelClient({ url: "https://api.example", key: KEY }, fetchImpl, timeoutMs);
  const reply = (body: string, init: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;

  test("a web page says the URL is wrong, not \"Unrecognized token '<'\"", async () => {
    const err = await client(reply("<!doctype html><html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }))
      .listIssues()
      .catch((e) => e);
    expect(err).toBeInstanceOf(SentrinelError);
    expect(err.message).toMatch(/not the Sentrinel API/);
    expect(err.message).toContain("SENTRINEL_API_URL");
    expect(err.message).not.toMatch(/Unrecognized token/);
  });

  test("a body that is not JSON, whatever its header claims, says the same", async () => {
    const err = await client(reply("<html>", { status: 200, headers: { "content-type": "application/json" } }))
      .listIssues()
      .catch((e) => e);
    expect(err.message).toMatch(/not the Sentrinel API/);
  });

  test("an error page from a proxy names the status and both likely causes", async () => {
    const err = await client(reply("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }))
      .listIssues()
      .catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/502/);
    expect(err.message).toMatch(/may be down/);
  });

  test("a plain-text 404 from the API stays a 404", async () => {
    const err = await client(reply("Not found", { status: 404, headers: { "content-type": "text/plain" } }))
      .getTrace("t")
      .catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Not found/);
  });

  test("a 429 says how long to wait, from either form of Retry-After", async () => {
    const secs = await client(reply("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }))
      .listIssues()
      .catch((e) => e);
    expect(secs.status).toBe(429);
    expect(secs.message).toMatch(/Retry after 30s/);

    const none = await client(reply("{}", { status: 429, headers: { "content-type": "application/json" } }))
      .listIssues()
      .catch((e) => e);
    expect(none.message).toMatch(/Wait a minute/);

    expect(retryAfter(new Date(Date.UTC(2030, 0, 1, 0, 5)).toUTCString(), Date.UTC(2030, 0, 1))).toBe("5 minutes");
    expect(retryAfter("nonsense")).toBeNull();
  });

  test("a hung API times out with a sentence, not a hang", async () => {
    const hang = ((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const err = await client(hang, 30).listIssues().catch((e) => e);
    expect(err).toBeInstanceOf(SentrinelError);
    expect(err.message).toMatch(/did not answer within/);
  });

  test("every request carries a deadline", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { issues: [] });
    await client(fetchImpl).listIssues();
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
