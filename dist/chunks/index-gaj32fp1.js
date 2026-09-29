// src/tracer.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
var traceStorage = new AsyncLocalStorage;
function generateTraceId() {
  return randomBytes(16).toString("hex");
}
function generateSpanId() {
  return randomBytes(8).toString("hex");
}
var lastUuidTimestamp = 0;
var uuidSeq = 0;
function generateUuidV7() {
  let timestamp = Date.now();
  if (timestamp === lastUuidTimestamp) {
    uuidSeq = uuidSeq + 1 & 4095;
  } else {
    lastUuidTimestamp = timestamp;
    uuidSeq = 0;
  }
  const hexTs = timestamp.toString(16).padStart(12, "0");
  const verSeqHex = (28672 | uuidSeq).toString(16).padStart(4, "0");
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  bytes[0] = bytes[0] & 63 | 128;
  const restHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hexTs.slice(0, 8)}-${hexTs.slice(8, 12)}-${verSeqHex}-${restHex.slice(0, 4)}-${restHex.slice(4, 16)}`;
}
function parseTraceParent(header) {
  if (!header)
    return null;
  const trimmed = header.trim();
  const w3cMatch = trimmed.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  if (w3cMatch) {
    return { traceId: w3cMatch[1].toLowerCase(), parentSpanId: w3cMatch[2].toLowerCase() };
  }
  if (/^[0-9a-f]{32}$/i.test(trimmed)) {
    return { traceId: trimmed.toLowerCase() };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return { traceId: trimmed.replace(/-/g, "").toLowerCase() };
  }
  return null;
}
function createTraceParentHeader(traceId, spanId) {
  const tId = traceId || generateTraceId();
  const sId = spanId || generateSpanId();
  return `00-${tId}-${sId}-01`;
}
function createClientTracer(config = {}) {
  const clientName = config.clientName || "web_client";
  return {
    getHeaders(existingHeaders = {}) {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      return {
        ...existingHeaders,
        traceparent: `00-${traceId}-${spanId}-01`,
        "x-trace-id": traceId,
        "x-consumer-id": clientName
      };
    },
    traceFetch(input, init) {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      const headers = new Headers(init?.headers);
      headers.set("traceparent", `00-${traceId}-${spanId}-01`);
      headers.set("x-trace-id", traceId);
      headers.set("x-consumer-id", clientName);
      return fetch(input, { ...init, headers });
    }
  };
}
var MAX_SPANS_PER_TRACE = 1000;
var NOOP_HANDLE = {
  setAttribute: () => {},
  setStatus: () => {},
  spanId: "",
  traceId: ""
};
function isThenable(value) {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function runInSpan(name, attributes, kind, fn) {
  const store = traceStorage.getStore();
  if (!store)
    return fn(NOOP_HANDLE);
  const spanId = generateSpanId();
  const started = Date.now();
  const startedPerf = nowMs();
  const inferredSource = name.startsWith("db.") ? "database" : name.startsWith("http.client") || kind === "CLIENT" ? "outbound" : "backend";
  const spanAttrs = { "sentrinel.source": inferredSource, ...attributes };
  const spanObj = {
    id: spanId,
    traceId: store.traceId,
    parentId: store.currentSpanId || undefined,
    name,
    kind,
    startTime: new Date(started).toISOString(),
    durationMs: 0,
    attributes: spanAttrs,
    statusCode: "OK"
  };
  const handle = {
    setAttribute: (key, value) => {
      spanAttrs[key] = value;
    },
    setStatus: (status, message) => {
      spanObj.statusCode = status;
      if (message)
        spanObj.statusMessage = message;
    },
    spanId,
    traceId: store.traceId
  };
  let finished = false;
  const finish = (failed, err) => {
    if (finished)
      return;
    finished = true;
    const duration = Math.max(0, nowMs() - startedPerf);
    spanObj.durationMs = Math.round(duration * 100) / 100;
    spanObj.endTime = new Date(started + duration).toISOString();
    if (failed) {
      spanObj.statusCode = "ERROR";
      spanObj.statusMessage = err?.message || String(err);
      spanAttrs["error.type"] = err?.name || "Error";
      spanAttrs["error.stack"] = err?.stack || "";
    }
    if (store.spans.length < MAX_SPANS_PER_TRACE)
      store.spans.push(spanObj);
    else
      store.droppedSpans = (store.droppedSpans ?? 0) + 1;
  };
  let result;
  try {
    result = traceStorage.run({ ...store, currentSpanId: spanId }, () => fn(handle));
  } catch (err) {
    finish(true, err);
    throw err;
  }
  if (isThenable(result)) {
    return result.then((value) => {
      finish(false);
      return value;
    }, (err) => {
      finish(true, err);
      throw err;
    });
  }
  finish(false);
  return result;
}
async function traceSpan(name, second, third = {}, fourth = "INTERNAL") {
  let fn;
  let attributes;
  let kind;
  if (typeof second === "function") {
    fn = second;
    attributes = third ?? {};
    kind = fourth;
  } else {
    fn = third;
    const { kind: k, attributes: attrs, ...rest } = second ?? {};
    attributes = { ...rest, ...attrs ?? {} };
    kind = k ?? "INTERNAL";
  }
  if (typeof fn !== "function") {
    throw new TypeError(`traceSpan("${name}") needs a function to run — call it as ` + `traceSpan(name, fn) or traceSpan(name, { kind }, fn).`);
  }
  return runInSpan(name, attributes, kind, fn);
}
var tspan = traceSpan;
function traced(nameOrFn, fn, attributes = {}) {
  const name = typeof nameOrFn === "string" ? nameOrFn : nameOrFn.name || "tracedFunction";
  const targetFn = typeof nameOrFn === "function" ? nameOrFn : fn;
  return function(...args) {
    return runInSpan(name, attributes, "INTERNAL", () => targetFn.apply(this, args));
  };
}
function traceObject(target, namePrefix) {
  const prefix = namePrefix ? `${namePrefix}.` : "";
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === "function" && typeof prop === "string" && prop !== "constructor") {
        const spanName = `${prefix}${prop}`;
        return (...args) => runInSpan(spanName, {}, "INTERNAL", () => val.apply(obj, args));
      }
      return val;
    }
  });
}
function redactUrl(url) {
  return url.replace(/([?&#])(token|key|api_?key|code|password|signature|sig|secret|access_token|refresh_token|id_token|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=([^&#]*)/gi, "$1$2=***");
}
async function sentrinelFetch(input, init) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  let urlStr = "";
  let method = "GET";
  try {
    urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    method = init?.method?.toUpperCase() || (isRequest ? input.method : "GET");
  } catch {}
  let pathname = urlStr;
  try {
    pathname = new URL(urlStr).pathname;
  } catch {}
  return runInSpan(`http.client ${method} ${pathname}`, {
    "http.url": redactUrl(urlStr),
    "http.method": method,
    component: "http"
  }, "CLIENT", async (span) => {
    let finalInit = init;
    if (span.spanId) {
      const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
      if (!headers.has("traceparent")) {
        headers.set("traceparent", `00-${span.traceId}-${span.spanId}-01`);
      }
      finalInit = { ...init, headers };
    }
    const res = await fetch(input, finalInit);
    span.setAttribute("http.status_code", res.status);
    if (res.status >= 500)
      span.setStatus("ERROR", `HTTP ${res.status}`);
    return res;
  });
}

export { traceStorage, generateTraceId, generateSpanId, generateUuidV7, parseTraceParent, createTraceParentHeader, createClientTracer, traceSpan, tspan, traced, traceObject, sentrinelFetch };
