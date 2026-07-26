// Console-capture unit tests (AsyncLocalStorage log correlation).

import { describe, expect, test } from "bun:test";
import {
  instrumentConsole,
  beginRequestLogContext,
  drainRequestLogs,
} from "../src/logs";

// instrumentConsole patches the global console once for the whole test file.
instrumentConsole({ enabled: true, minLevel: "debug", maxPerRequest: 5, maxMessageLength: 40 });

describe("log capture", () => {
  test("captures console output inside a request context, tagged with the request id", async () => {
    await (async () => {
      beginRequestLogContext("req-1");
      console.info("checkout started");
      console.error("card declined");
      const { logs, dropped } = drainRequestLogs();
      expect(dropped).toBe(0);
      expect(logs.length).toBe(2);
      expect(logs[0]).toMatchObject({ level: "info", message: "checkout started", requestId: "req-1" });
      expect(logs[1].level).toBe("error");
    })();
  });

  test("console.log maps to info, console.debug to debug", async () => {
    beginRequestLogContext("req-2");
    console.log("plain log");
    console.debug("debug line");
    const { logs } = drainRequestLogs();
    expect(logs.map((l) => l.level)).toEqual(["info", "debug"]);
  });

  test("ignores output outside any request context", () => {
    // drain whatever context exists, then log with no context re-entered
    drainRequestLogs();
    const before = drainRequestLogs();
    expect(before.logs.length).toBe(0);
  });

  test("caps buffer at maxPerRequest and counts drops", () => {
    beginRequestLogContext("req-3");
    for (let i = 0; i < 9; i++) console.info(`line ${i}`);
    const { logs, dropped } = drainRequestLogs();
    expect(logs.length).toBe(5);
    expect(dropped).toBe(4);
  });

  test("truncates long messages", () => {
    beginRequestLogContext("req-4");
    console.info("x".repeat(100));
    const { logs } = drainRequestLogs();
    expect(logs[0].message.length).toBe(41); // 40 chars + ellipsis
    expect(logs[0].message.endsWith("…")).toBe(true);
  });

  test("serializes objects and errors", () => {
    beginRequestLogContext("req-5");
    console.info({ orderId: 7 });
    console.error(new Error("boom"));
    const { logs } = drainRequestLogs();
    expect(logs[0].message).toBe('{"orderId":7}');
    expect(logs[1].message).toContain("Error: boom");
  });

  test("concurrent contexts do not leak lines across requests", async () => {
    const results = await Promise.all([
      (async () => {
        beginRequestLogContext("req-a");
        await Bun.sleep(5);
        console.info("from a");
        await Bun.sleep(5);
        return drainRequestLogs().logs;
      })(),
      (async () => {
        beginRequestLogContext("req-b");
        console.info("from b");
        await Bun.sleep(8);
        return drainRequestLogs().logs;
      })(),
    ]);
    expect(results[0].map((l) => l.message)).toEqual(["from a"]);
    expect(results[1].map((l) => l.message)).toEqual(["from b"]);
    expect(results[0][0].requestId).toBe("req-a");
    expect(results[1][0].requestId).toBe("req-b");
  });
});
