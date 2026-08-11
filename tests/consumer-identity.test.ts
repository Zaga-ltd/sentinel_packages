// Consumer identity: the identifier, and the two display fields beside it.
//
// The identifier is the only part anything joins on, so the tests that matter
// are the ones proving it survives every input shape — and that a resolver
// returning an object never stringifies into "[object Object]", which is what
// happens when an adapter is left un-updated.

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { sentrinelPlugin } from "../src/index";
import { resolveConsumer } from "../src/types";

describe("resolveConsumer", () => {
  test("a bare string is the identifier", () => {
    expect(resolveConsumer("usr_42")).toEqual({ identifier: "usr_42" });
  });

  test("an identity carries name and group through", () => {
    expect(
      resolveConsumer({ identifier: "usr_42", name: "Jane", group: "enterprise" })
    ).toEqual({ identifier: "usr_42", name: "Jane", group: "enterprise" });
  });

  test("an identity may omit the display fields", () => {
    const r = resolveConsumer({ identifier: "usr_42" });
    expect(r.identifier).toBe("usr_42");
    expect(r.name).toBeUndefined();
    expect(r.group).toBeUndefined();
  });

  test("null, undefined and empty string all mean anonymous", () => {
    for (const v of [null, undefined, ""] as const) {
      expect(resolveConsumer(v).identifier).toBeNull();
    }
  });

  test("an object without an identifier is not usable", () => {
    // Name alone cannot key a consumer — better an honest anonymous row than
    // one keyed on a display string that changes when someone is renamed.
    expect(resolveConsumer({ identifier: "", name: "Jane" }).identifier).toBeNull();
  });
});

/** Captures what the plugin would have sent, instead of sending it. */
function recorder() {
  const sent: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    if (String(url).includes("/api/ingest/metrics")) {
      sent.push(JSON.parse(init.body));
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

async function runWith(
  consumerIdentifier: any,
  headers: Record<string, string> = {}
): Promise<any[]> {
  const originalFetch = globalThis.fetch;
  const { sent, fetchImpl } = recorder();
  globalThis.fetch = fetchImpl;

  try {
    const app = new Elysia()
      .use(
        sentrinelPlugin({
          serverUrl: "http://consumer.test",
          appName: "consumer-test",
          env: "test",
          // The app is never listened on, so onStop never fires and there is no
          // handle to flush by hand. A short interval is the honest way to get
          // a batch out of a plugin under test.
          flushInterval: 60,
          consumerIdentifier,
        })
      )
      .get("/thing", () => ({ ok: true }));

    await app.handle(new Request("http://local/thing", { headers }));
    await Bun.sleep(220);
    return sent.flatMap((p) => p.consumers ?? []);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("the plugin resolves both shapes", () => {
  test("a string resolver still works", async () => {
    const consumers = await runWith(() => "usr_string");
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers[0].identifier).toBe("usr_string");
    expect(consumers[0].name).toBeUndefined();
  });

  test("an identity resolver sends name and group", async () => {
    const consumers = await runWith(() => ({
      identifier: "usr_rich",
      name: "Jane at Acme",
      group: "enterprise",
    }));
    expect(consumers[0].identifier).toBe("usr_rich");
    expect(consumers[0].name).toBe("Jane at Acme");
    expect(consumers[0].group).toBe("enterprise");
  });

  test("the header shorthand is unchanged", async () => {
    const consumers = await runWith("x-consumer-id", { "x-consumer-id": "usr_header" });
    expect(consumers[0].identifier).toBe("usr_header");
  });

  test("an identifier is never the stringified object", async () => {
    const consumers = await runWith(() => ({ identifier: "usr_obj", name: "Jane" }));
    for (const c of consumers) {
      expect(c.identifier).not.toContain("[object");
    }
  });

  test("a resolver that throws leaves the request anonymous, not broken", async () => {
    const consumers = await runWith(() => {
      throw new Error("resolver blew up");
    });
    expect(consumers.length).toBe(0);
  });
});
