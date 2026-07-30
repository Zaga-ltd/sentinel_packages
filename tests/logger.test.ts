// Structured logging.
//
// The properties that matter: the message stays stable so occurrences group,
// the attributes carry the queryable detail, context is inherited by code that
// never sees the request, and every record is correlated to its request/trace/
// span. If any of those break, logs quietly become un-queryable again.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  getLogger,
  logger,
  withContext,
  addContext,
  currentContext,
  setLogSink,
  resetLogSink,
  setCorrelationSource,
  setLogLevel,
  enterRequestScope,
  clearRequestScope,
  type LogRecord,
} from "../src/logger";

let captured: LogRecord[] = [];

beforeEach(() => {
  captured = [];
  // enterWith() persists for the rest of the async execution, so a request
  // scope opened by one test would otherwise still be active in the next.
  clearRequestScope();
  resetLogSink();
  setLogLevel("debug");
  setCorrelationSource(() => ({}));
  setLogSink((r) => captured.push(r));
});

afterEach(() => {
  resetLogSink();
});

describe("structured records", () => {
  test("message and attributes are stored separately", () => {
    getLogger("api").info("Checkout completed", { orderId: "ord_1", total: 125.5 });

    expect(captured).toHaveLength(1);
    const [record] = captured;
    // The message is the group key; values live in attributes where they can
    // be filtered. Interpolating them into the string would make every
    // occurrence unique and ungroupable.
    expect(record.message).toBe("Checkout completed");
    expect(record.attributes).toEqual({ orderId: "ord_1", total: 125.5 });
    expect(record.level).toBe("info");
    expect(record.category).toBe("api");
  });

  test("a placeholder message is stored verbatim, not interpolated", () => {
    getLogger().info("Fetched {count} orders for {userId}", { count: 12, userId: "u_9" });

    // Two calls with different values must still be the same message.
    expect(captured[0].message).toBe("Fetched {count} orders for {userId}");
    expect(captured[0].attributes).toEqual({ count: 12, userId: "u_9" });
  });

  test("every level is emitted and labelled", () => {
    const log = getLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(captured.map((r) => r.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("records below the configured level are dropped", () => {
    setLogLevel("warn");
    const log = getLogger();
    log.debug("dropped");
    log.info("dropped");
    log.warn("kept");
    log.error("kept");
    expect(captured.map((r) => r.message)).toEqual(["kept", "kept"]);
  });
});

describe("categories", () => {
  test("array and dotted forms are equivalent", () => {
    getLogger(["api", "checkout"]).info("a");
    getLogger("api.checkout").info("b");
    expect(captured[0].category).toBe("api.checkout");
    expect(captured[1].category).toBe("api.checkout");
  });

  test("getChild nests under the parent", () => {
    const parent = getLogger("payment");
    parent.getChild("fraud").warn("Blocked");
    expect(captured[0].category).toBe("payment.fraud");
  });

  test("with() binds attributes to every record from that logger", () => {
    const scoped = getLogger("worker").with({ jobId: "job_7" });
    scoped.info("Started");
    scoped.info("Finished", { durationMs: 42 });

    expect(captured[0].attributes).toEqual({ jobId: "job_7" });
    expect(captured[1].attributes).toEqual({ jobId: "job_7", durationMs: 42 });
  });
});

describe("context propagation", () => {
  test("withContext reaches code that never saw the request", () => {
    // The point: this helper knows nothing about users, yet its log carries one.
    function deepHelper() {
      getLogger("db").info("Query executed", { table: "orders" });
    }

    withContext({ userId: "u_1", tenantId: "t_9" }, () => {
      deepHelper();
    });

    expect(captured[0].attributes).toEqual({
      userId: "u_1",
      tenantId: "t_9",
      table: "orders",
    });
  });

  test("nested scopes merge, inner winning", () => {
    withContext({ tenantId: "t_1", stage: "outer" }, () => {
      withContext({ stage: "inner", orderId: "o_2" }, () => {
        getLogger().info("Nested");
      });
    });

    expect(captured[0].attributes).toEqual({
      tenantId: "t_1",
      stage: "inner",
      orderId: "o_2",
    });
  });

  test("explicit attributes beat inherited context", () => {
    withContext({ tier: "free" }, () => {
      getLogger().info("Upgraded", { tier: "enterprise" });
    });
    expect((captured[0].attributes as any).tier).toBe("enterprise");
  });

  test("context does not leak outside its scope", () => {
    withContext({ userId: "u_1" }, () => {
      getLogger().info("inside");
    });
    getLogger().info("outside");

    expect(captured[0].attributes).toEqual({ userId: "u_1" });
    expect(captured[1].attributes).toBeUndefined();
  });

  test("addContext extends the current scope", () => {
    withContext({ a: 1 }, () => {
      addContext({ b: 2 });
      expect(currentContext()).toEqual({ a: 1, b: 2 });
      getLogger().info("both");
    });
    expect(captured[0].attributes).toEqual({ a: 1, b: 2 });
  });
});

describe("correlation", () => {
  test("records carry the active request, trace and span", () => {
    setCorrelationSource(() => ({
      requestId: "req_1",
      traceId: "trace_abc",
      spanId: "span_xyz",
    }));

    getLogger("api").error("Payment failed", { provider: "stripe" });

    const [record] = captured;
    expect(record.requestId).toBe("req_1");
    expect(record.traceId).toBe("trace_abc");
    expect(record.spanId).toBe("span_xyz");
  });

  test("logs outside a request simply have no correlation", () => {
    // Background jobs and startup still log; they just aren't tied to a request.
    getLogger("boot").info("Server started", { port: 3000 });
    expect(captured[0].requestId).toBeUndefined();
    expect(captured[0].message).toBe("Server started");
  });
});

describe("multi-app processes", () => {
  test("a request's logs go to the app handling it, not the last plugin loaded", () => {
    // Three services in one process is exactly the demo cluster's shape. With a
    // single global sink, whichever plugin initialised last swallowed every
    // app's logs and filed them under its own name.
    const appA: LogRecord[] = [];
    const appB: LogRecord[] = [];

    resetLogSink();
    setLogSink((r) => appA.push(r)); // first registration wins the default
    const sinkB = (r: LogRecord) => appB.push(r);

    // Outside any request → the default sink.
    getLogger().info("background work");

    // Inside a request owned by app B → B's sink.
    enterRequestScope("req_b", sinkB);
    getLogger().info("handled by B");

    expect(appA.map((r) => r.message)).toEqual(["background work"]);
    expect(appB.map((r) => r.message)).toEqual(["handled by B"]);
  });
});

describe("buffering", () => {
  test("records emitted before a sink exists are not lost", () => {
    resetLogSink();
    logger.info("emitted at import time");

    const late: LogRecord[] = [];
    setLogSink((r) => late.push(r));

    expect(late.map((r) => r.message)).toEqual(["emitted at import time"]);
  });
});
