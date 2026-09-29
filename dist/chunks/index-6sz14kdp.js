import {
  generateSpanId,
  generateTraceId,
  parseTraceParent,
  traceStorage
} from "./index-gaj32fp1.js";

// src/body.ts
var UNCAPTURABLE = [
  "multipart/",
  "application/octet-stream",
  "image/",
  "audio/",
  "video/",
  "font/",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-protobuf",
  "application/protobuf",
  "application/grpc",
  "text/event-stream",
  "application/x-ndjson"
];
function isCapturableBody(contentType, contentEncoding) {
  if (contentEncoding && !/^\s*(identity)?\s*$/i.test(contentEncoding))
    return false;
  if (!contentType)
    return true;
  const type = contentType.toLowerCase();
  return !UNCAPTURABLE.some((prefix) => type.startsWith(prefix) || type.includes(prefix));
}
async function readBoundedText(stream, maxBytes) {
  if (!stream)
    return;
  const limit = Math.max(0, maxBytes);
  let reader;
  try {
    reader = stream.getReader();
  } catch {
    return;
  }
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (!value)
        continue;
      const chunk = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (bytes + chunk.byteLength > limit) {
        const room = limit - bytes;
        if (room > 0)
          chunks.push(chunk.subarray(0, room));
        bytes += Math.max(0, room);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } catch {} finally {
    if (truncated) {
      reader.cancel().catch(() => {});
    } else {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
  return { text, truncated, bytes };
}
async function peekBody(message, maxBytes) {
  try {
    if (!message.body)
      return;
    if (message.bodyUsed)
      return;
    if (!isCapturableBody(message.headers.get("content-type"), message.headers.get("content-encoding"))) {
      return;
    }
    return await readBoundedText(message.clone().body, maxBytes);
  } catch {
    return;
  }
}

// src/metrics.ts
var MAX_NAME = 128;
var MAX_LABEL_KEYS = 12;
var MAX_LABEL_VALUE = 128;
var MAX_SERIES = 2000;
var MAX_SAMPLES = 512;
function canonicalLabels(labels) {
  if (!labels)
    return "{}";
  const keys = Object.keys(labels).sort().slice(0, MAX_LABEL_KEYS);
  const out = {};
  for (const key of keys) {
    const value = labels[key];
    if (value === undefined || value === null)
      continue;
    out[key] = String(value).slice(0, MAX_LABEL_VALUE);
  }
  return JSON.stringify(out);
}
function percentile(sorted, q) {
  if (!sorted.length)
    return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

class MetricRegistry {
  series = new Map;
  droppedSeries = 0;
  record(name, kind, value, labels, unit) {
    if (!name || typeof name !== "string")
      return;
    if (!Number.isFinite(value))
      return;
    const clean = name.trim().slice(0, MAX_NAME);
    if (!clean)
      return;
    const canon = canonicalLabels(labels);
    const key = `${clean}\x00${kind}\x00${canon}`;
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES) {
        this.droppedSeries++;
        return;
      }
      entry = {
        name: clean,
        kind,
        labels: canon,
        unit,
        count: 0,
        sum: 0,
        min: value,
        max: value,
        last: value,
        samples: [],
        seen: 0
      };
      this.series.set(key, entry);
    }
    entry.count++;
    entry.sum += value;
    entry.last = value;
    if (value < entry.min)
      entry.min = value;
    if (value > entry.max)
      entry.max = value;
    if (unit && !entry.unit)
      entry.unit = unit;
    if (kind === "histogram") {
      entry.seen++;
      if (entry.samples.length < MAX_SAMPLES) {
        entry.samples.push(value);
      } else {
        const j = Math.floor(Math.random() * entry.seen);
        if (j < MAX_SAMPLES)
          entry.samples[j] = value;
      }
    }
  }
  get size() {
    return this.series.size;
  }
  drain(now = new Date) {
    if (!this.series.size)
      return [];
    const timestamp = now.toISOString();
    const out = [];
    for (const s of this.series.values()) {
      const sorted = s.samples.length ? [...s.samples].sort((a, b) => a - b) : [];
      out.push({
        name: s.name,
        kind: s.kind,
        labels: s.labels,
        unit: s.unit,
        count: s.count,
        sum: s.sum,
        min: s.min,
        max: s.max,
        last: s.last,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        timestamp
      });
    }
    this.series.clear();
    return out;
  }
}
var registry = new MetricRegistry;
function metricRegistry() {
  return registry;
}
function count(name, value = 1, labels, unit) {
  registry.record(name, "counter", value, labels, unit);
}
function gauge(name, value, labels, unit) {
  registry.record(name, "gauge", value, labels, unit);
}
function histogram(name, value, labels, unit) {
  registry.record(name, "histogram", value, labels, unit);
}
var metric = { count, gauge, histogram };

// src/process-hooks.ts
var KEY = Symbol.for("sentrinel.processHooks");
function registry2() {
  const g = globalThis;
  if (!g[KEY]) {
    g[KEY] = {
      collectors: new Map,
      installed: { signals: false, exit: false, errors: false },
      reported: new WeakSet,
      exiting: false
    };
  }
  return g[KEY];
}
function settingsFrom(options) {
  const raw = options.processHooks;
  if (raw === false)
    return null;
  if (raw === undefined && typeof process !== "undefined" && process.env?.NODE_ENV === "test")
    return null;
  const obj = typeof raw === "object" && raw ? raw : {};
  return {
    flushOnExit: obj.flushOnExit !== false,
    captureErrors: obj.captureErrors !== false,
    timeoutMs: typeof obj.timeoutMs === "number" && obj.timeoutMs >= 0 ? obj.timeoutMs : 3000
  };
}
function hasProcessEvents() {
  return typeof process !== "undefined" && typeof process.on === "function" && typeof process.listenerCount === "function";
}
function registerCollector(collector, options) {
  const settings = settingsFrom(options);
  if (!settings || !hasProcessEvents())
    return;
  const reg = registry2();
  reg.collectors.set(collector, settings);
  if (settings.flushOnExit)
    installExitHooks(reg);
  if (settings.captureErrors)
    installErrorHooks(reg);
}
function unregisterCollector(collector) {
  if (!hasProcessEvents())
    return;
  registry2().collectors.delete(collector);
}
function longestTimeout(reg) {
  let max = 0;
  for (const s of reg.collectors.values())
    max = Math.max(max, s.timeoutMs);
  return max;
}
async function flushAll(timeoutMs = longestTimeout(registry2())) {
  const reg = registry2();
  const flushes = [...reg.collectors.keys()].map((c) => c.finalFlushNow().catch(() => {}));
  if (!flushes.length)
    return;
  let timer;
  await Promise.race([
    Promise.allSettled(flushes),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer?.unref?.();
    })
  ]);
  clearTimeout(timer);
}
function installExitHooks(reg) {
  if (!reg.installed.signals) {
    reg.installed.signals = true;
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const handler = () => {
        const alone = process.listenerCount(signal) <= 1;
        flushAll().finally(() => {
          if (alone) {
            process.removeListener(signal, handler);
            try {
              process.kill(process.pid, signal);
            } catch {
              process.exit(signal === "SIGINT" ? 130 : 143);
            }
          }
        });
      };
      process.on(signal, handler);
    }
  }
  if (!reg.installed.exit) {
    reg.installed.exit = true;
    process.on("beforeExit", () => {
      if (reg.exiting)
        return;
      const pending = [...reg.collectors.keys()].some((c) => c.hasPendingData());
      if (pending)
        flushAll();
    });
  }
}
function toError(reason) {
  if (reason instanceof Error)
    return reason;
  const err = new Error(typeof reason === "string" ? reason : `Non-Error rejection: ${safeString(reason)}`);
  err.name = "UnhandledRejection";
  return err;
}
function safeString(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function record(reg, err, origin) {
  if (reg.reported.has(err))
    return;
  reg.reported.add(err);
  const first = reg.collectors.keys().next().value;
  if (!first)
    return;
  try {
    first.recordError({
      method: "PROCESS",
      path: origin,
      statusCode: 0,
      statusMessage: origin === "unhandledRejection" ? "Unhandled rejection" : "Uncaught exception",
      errorType: err.name || "Error",
      errorMessage: String(err.message ?? "").slice(0, 2000),
      stackTrace: typeof err.stack === "string" ? err.stack.slice(0, 16000) : undefined,
      timestamp: new Date().toISOString(),
      attributes: { "error.handled": false, "error.mechanism": origin }
    });
  } catch {}
}
function rejectionMode() {
  const args = [...process.execArgv ?? [], ...String(process.env?.NODE_OPTIONS ?? "").split(/\s+/)];
  for (const a of args) {
    const m = /^--unhandled-rejections=(\S+)$/.exec(a);
    if (m)
      return m[1];
  }
  return "throw";
}
function installErrorHooks(reg) {
  if (reg.installed.errors)
    return;
  reg.installed.errors = true;
  const onUncaught = (error, origin) => {
    const err = toError(error);
    record(reg, err, origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException");
    if (process.listenerCount("uncaughtException") > 1) {
      flushAll();
      return;
    }
    if (reg.exiting)
      return;
    reg.exiting = true;
    try {
      process.stderr.write(`${err.stack ?? `${err.name}: ${err.message}`}
`);
    } catch {}
    process.exitCode = 1;
    flushAll().finally(() => process.exit(1));
  };
  const onRejection = (reason) => {
    const err = toError(reason);
    record(reg, err, "unhandledRejection");
    if (process.listenerCount("unhandledRejection") > 1)
      return;
    const mode = rejectionMode();
    if (mode === "none")
      return;
    if (mode === "warn" || mode === "warn-with-error-code") {
      if (mode === "warn-with-error-code")
        process.exitCode = 1;
      try {
        process.stderr.write(`Unhandled promise rejection: ${err.stack ?? err.message}
`);
      } catch {}
      return;
    }
    process.emit("uncaughtException", err, "unhandledRejection");
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
}

// src/masking.ts
var MASK_VALUE = "***";
function normalise(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
var SECRET_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "creditcard",
  "cardnumber",
  "ccnumber",
  "cvv",
  "cvc",
  "privatekey",
  "credential"
];
var SECRET_SUFFIXES = ["token", "signature"];
var SECRET_EXACT_BODY = new Set(["pwd", "pin", "ssn", "otp"]);
function isDefaultSecretName(name) {
  const n = normalise(name);
  if (!n)
    return false;
  if (SECRET_EXACT_BODY.has(n))
    return true;
  if (SECRET_SUFFIXES.some((s) => n.endsWith(s)))
    return true;
  return SECRET_FRAGMENTS.some((f) => n.includes(f));
}
var SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token"
]);
function isDefaultSecretHeader(name) {
  return SECRET_HEADERS.has(name.toLowerCase()) || isDefaultSecretName(name);
}
var SECRET_QUERY_EXACT = new Set([
  "token",
  "key",
  "apikey",
  "code",
  "password",
  "signature",
  "sig",
  "secret",
  "auth",
  "session",
  "sessionid",
  "jwt"
]);
function isDefaultSecretQueryKey(name) {
  const n = normalise(name);
  return SECRET_QUERY_EXACT.has(n) || isDefaultSecretName(name);
}
function matchesPattern(fieldName, patterns) {
  if (!patterns)
    return false;
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (fieldName.toLowerCase() === pattern.toLowerCase())
        return true;
    } else if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      if (pattern.test(fieldName))
        return true;
    }
  }
  return false;
}
function shouldMaskHeader(name, patterns) {
  return isDefaultSecretHeader(name) || matchesPattern(name, patterns);
}
function shouldMaskField(name, patterns) {
  return isDefaultSecretName(name) || matchesPattern(name, patterns);
}
function shouldMaskQueryKey(name, patterns) {
  return isDefaultSecretQueryKey(name) || matchesPattern(name, patterns);
}
function maskQueryParams(params, patterns) {
  if (!params)
    return;
  const masked = {};
  for (const [key, value] of Object.entries(params)) {
    masked[key] = shouldMaskQueryKey(key, patterns) ? MASK_VALUE : value;
  }
  return masked;
}
function maskHeaders(headers, patterns) {
  if (!headers)
    return;
  const masked = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = shouldMaskHeader(key, patterns) ? MASK_VALUE : value;
  }
  return masked;
}
function maskBodyFields(body, patterns, contentType) {
  if (body === null || body === undefined || body === "")
    return body;
  if (typeof body === "string")
    return maskBodyText(body, patterns, contentType);
  if (typeof body === "object") {
    return maskObjectFields(body, patterns, 0);
  }
  return body;
}
function maskBodyText(text, patterns, contentType) {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("multipart/form-data") || /^--[^\r\n]{1,200}\r?\ncontent-disposition:/i.test(text)) {
    return maskMultipart(text, patterns);
  }
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson || type.includes("json")) {
    try {
      return JSON.stringify(maskObjectFields(JSON.parse(text), patterns, 0));
    } catch {
      return maskJsonLikeText(text, patterns);
    }
  }
  if (type.includes("x-www-form-urlencoded") || looksFormEncoded(trimmed)) {
    return maskFormEncoded(text, patterns);
  }
  return maskJsonLikeText(text, patterns);
}
function maskObjectFields(obj, patterns, depth) {
  if (obj === null || obj === undefined)
    return obj;
  if (typeof obj !== "object")
    return obj;
  if (depth > 32)
    return "[depth limit]";
  if (Array.isArray(obj)) {
    return obj.map((item) => maskObjectFields(item, patterns, depth + 1));
  }
  const masked = {};
  for (const [key, value] of Object.entries(obj)) {
    if (shouldMaskField(key, patterns)) {
      masked[key] = MASK_VALUE;
    } else if (typeof value === "object" && value !== null) {
      masked[key] = maskObjectFields(value, patterns, depth + 1);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
function looksFormEncoded(text) {
  return /^[^\s=&{}[\]]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*&?$/.test(text.slice(0, 4096));
}
function maskFormEncoded(text, patterns) {
  return text.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0)
      return pair;
    const rawKey = pair.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {}
    return shouldMaskField(key, patterns) ? `${rawKey}=${MASK_VALUE}` : pair;
  }).join("&");
}
function maskMultipart(text, patterns) {
  return text.replace(/(content-disposition:[^\r\n]*\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--|$)/gi, (whole, head, name) => shouldMaskField(name, patterns) ? `${head}${MASK_VALUE}` : whole);
}
function maskJsonLikeText(text, patterns) {
  return text.replace(/"((?:[^"\\\r\n]|\\.){1,200})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\]\s]+)/g, (whole, key, sep) => shouldMaskField(key, patterns) ? `"${key}"${sep}"${MASK_VALUE}"` : whole);
}
function maskUrl(url, patterns) {
  if (!url || url.indexOf("?") < 0 && url.indexOf("#") < 0)
    return url;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt + 1) : undefined;
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : undefined;
  let out = base;
  if (query !== undefined)
    out += `?${maskParamString(query, patterns)}`;
  if (hash !== undefined) {
    out += `#${hash.includes("=") ? maskParamString(hash, patterns) : hash}`;
  }
  return out;
}
function maskParamString(params, patterns) {
  return params.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0)
      return pair;
    const rawKey = pair.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {}
    return shouldMaskQueryKey(key, patterns) ? `${rawKey}=${MASK_VALUE}` : pair;
  }).join("&");
}
function truncateBody(body, maxSize = 1e4, totalBytes) {
  if (!body)
    return;
  if (body.length <= maxSize)
    return body;
  const total = totalBytes ?? body.length;
  return body.slice(0, maxSize) + `... [truncated, ${total} bytes total]`;
}

// src/logger.ts
import { AsyncLocalStorage } from "node:async_hooks";
var contextStorage = new AsyncLocalStorage;
function withContext(fields, fn) {
  const parent = contextStorage.getStore() ?? {};
  return contextStorage.run({ ...parent, ...fields }, fn);
}
function addContext(fields) {
  const store = contextStorage.getStore();
  if (store)
    Object.assign(store, fields);
}
function currentContext() {
  return { ...contextStorage.getStore() ?? {} };
}
var correlationSource = null;
function setCorrelationSource(fn) {
  correlationSource = fn;
}
var requestStorage = new AsyncLocalStorage;
function enterRequestScope(requestId, sink) {
  requestStorage.enterWith({ requestId, sink });
}
function runInRequestScope(requestId, sink, fn) {
  return requestStorage.run({ requestId, sink }, fn);
}
function clearRequestScope() {
  requestStorage.enterWith({ requestId: "" });
}
function currentRequestId() {
  return requestStorage.getStore()?.requestId || undefined;
}
var canonicalStorage = new AsyncLocalStorage;
function createCanonicalScope() {
  return { fields: {} };
}
function enterCanonicalScope(scope) {
  canonicalStorage.enterWith(scope);
}
function runInCanonicalScope(scope, fn) {
  return canonicalStorage.run(scope, fn);
}
function drainCanonicalScope(scope) {
  if (!scope || !Object.keys(scope.fields).length)
    return;
  const fields = { ...scope.fields };
  scope.fields = {};
  return fields;
}
function addRequestContext(fields) {
  const store = canonicalStorage.getStore();
  if (store)
    Object.assign(store.fields, fields);
}
var defaultSink = null;
var pending = [];
var MAX_PENDING = 500;
function setLogSink(fn) {
  if (!defaultSink) {
    defaultSink = fn;
    while (pending.length)
      fn(pending.shift());
  }
}
var echo = false;
function setLogEcho(on) {
  echo = on;
}
var minLevel = "debug";
function setLogLevel(level) {
  minLevel = level;
}
var LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
function interpolate(message, values) {
  return message.replace(/\{(\w+)\}/g, (whole, key) => (key in values) ? String(values[key]) : whole);
}
function emit(level, category, message, attributes) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel])
    return;
  const context = contextStorage.getStore();
  const merged = context || attributes ? { ...context ?? {}, ...attributes ?? {} } : undefined;
  const correlation = correlationSource?.() ?? {};
  const record2 = {
    timestamp: new Date().toISOString(),
    level,
    message,
    category,
    attributes: merged && Object.keys(merged).length ? merged : undefined,
    ...correlation
  };
  if (echo) {
    const rendered = merged ? interpolate(message, merged) : message;
    const suffix = merged ? " " + JSON.stringify(merged) : "";
    const tag = category ? `[${category}] ` : "";
    process.stdout.write(`${record2.timestamp} ${level.toUpperCase().padEnd(5)} ${tag}${rendered}${suffix}
`);
  }
  const target = requestStorage.getStore()?.sink ?? defaultSink;
  if (target)
    target(record2);
  else if (pending.length < MAX_PENDING)
    pending.push(record2);
}
function makeLogger(parts, bound) {
  const category = parts.join(".");
  const log = (level) => (message, attributes) => {
    const merged = Object.keys(bound).length || attributes ? { ...bound, ...attributes ?? {} } : undefined;
    emit(level, category || undefined, message, merged);
  };
  return {
    category,
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    getChild: (child) => makeLogger([...parts, ...toParts(child)], bound),
    with: (attributes) => makeLogger(parts, { ...bound, ...attributes })
  };
}
function toParts(category) {
  if (!category)
    return [];
  return Array.isArray(category) ? category.filter(Boolean) : category.split(".").filter(Boolean);
}
function getLogger(category) {
  return makeLogger(toParts(category), {});
}
var logger = getLogger();

// src/route-path.ts
var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var NUMERIC = /^\d+$/;
var HEX = /^[0-9a-fA-F]{16,}$/;
var DATE = /^\d{4}-\d{2}(-\d{2})?$/;
var PREFIXED = /^([A-Za-z][A-Za-z_]*)-(.+)$/;
var FILENAME = /^(.+)\.([A-Za-z0-9]{1,5})$/;
function looksLikeId(s) {
  if (s.length < 8)
    return false;
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    return false;
  return /\d/.test(s) || /[a-z]/.test(s) && /[A-Z]/.test(s);
}
function normaliseSegment(segment) {
  if (UUID.test(segment))
    return "{uuid}";
  if (NUMERIC.test(segment))
    return "{id}";
  if (HEX.test(segment))
    return "{hash}";
  if (DATE.test(segment))
    return "{date}";
  const prefixed = PREFIXED.exec(segment);
  if (prefixed && looksLikeId(prefixed[2]))
    return "{id}";
  if (segment.length >= 10 && /^[A-Za-z0-9]+$/.test(segment) && looksLikeId(segment)) {
    return "{id}";
  }
  const file = FILENAME.exec(segment);
  if (file) {
    const stem = normaliseSegment(file[1]);
    if (stem !== file[1])
      return `${stem}.${file[2]}`;
  }
  return segment;
}
function normaliseRoutePath(path) {
  if (!path)
    return "";
  const clean = path.split("?")[0].split("#")[0];
  if (!clean.includes("/"))
    return normaliseSegment(clean);
  return clean.split("/").map((s) => s ? normaliseSegment(s) : s).join("/");
}

// src/retry.ts
var DEFAULTS = {
  maxQueued: 100,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxAttempts: 5,
  baseDelayMs: 5000,
  maxDelayMs: 300000
};
function isRetryable(status) {
  if (status === undefined)
    return true;
  if (status === 408)
    return true;
  if (status === 429)
    return true;
  if (status >= 500)
    return true;
  return false;
}

class RetryQueue {
  queue = [];
  bytes = 0;
  opts;
  droppedForSpace = 0;
  droppedForAttempts = 0;
  constructor(options = {}) {
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.opts = { ...DEFAULTS, ...defined };
  }
  get size() {
    return this.queue.length;
  }
  get queuedBytes() {
    return this.bytes;
  }
  drainDropCounts() {
    const counts = { space: this.droppedForSpace, attempts: this.droppedForAttempts };
    this.droppedForSpace = 0;
    this.droppedForAttempts = 0;
    return counts;
  }
  enqueue(path, body, status, attempts = 0, bytes = 0) {
    if (!isRetryable(status))
      return false;
    if (attempts + 1 >= this.opts.maxAttempts) {
      this.droppedForAttempts++;
      return false;
    }
    const next = attempts + 1;
    const backoff = Math.min(this.opts.baseDelayMs * 2 ** attempts, this.opts.maxDelayMs);
    const jitter = backoff * (0.5 + Math.random() * 0.5);
    this.queue.push({
      path,
      body,
      attempts: next,
      nextAttemptAt: Date.now() + jitter,
      queuedAt: Date.now(),
      bytes
    });
    this.bytes += bytes;
    while (this.queue.length > 1 && (this.queue.length > this.opts.maxQueued || this.bytes > this.opts.maxQueuedBytes)) {
      const dropped = this.queue.shift();
      this.bytes -= dropped.bytes;
      this.droppedForSpace++;
    }
    if (this.queue.length > this.opts.maxQueued) {
      const dropped = this.queue.shift();
      this.bytes -= dropped.bytes;
      this.droppedForSpace++;
      return false;
    }
    return true;
  }
  due(now = Date.now()) {
    if (!this.queue.length)
      return [];
    const ready = [];
    const waiting = [];
    for (const item of this.queue) {
      (item.nextAttemptAt <= now ? ready : waiting).push(item);
    }
    this.queue = waiting;
    this.bytes = waiting.reduce((sum, i) => sum + i.bytes, 0);
    return ready;
  }
  takeAll() {
    const all = this.queue;
    this.queue = [];
    this.bytes = 0;
    return all;
  }
  clear() {
    this.queue = [];
    this.bytes = 0;
  }
}

// src/collector.ts
import { hostname } from "node:os";
var INSTANCE_ID = (() => {
  try {
    return `${hostname()}:${process.pid}`.slice(0, 128);
  } catch {
    return `pid:${process.pid}`;
  }
})();
var MAX_REQUESTS_PER_BATCH = 5000;
var MAX_LOGS_PER_BATCH = 5000;
var MAX_ERRORS_PER_BATCH = 2000;
var MAX_ENDPOINTS_PER_BATCH = 2000;
var MAX_CONSUMERS_PER_BATCH = 5000;
var MAX_CUSTOM_METRICS_PER_BATCH = 2000;
var MAX_TRACES_PER_BATCH = 500;
var MAX_SPANS_PER_BATCH = 1e4;
var SPLITTABLE = {
  "/api/ingest/requests": ["requests"],
  "/api/ingest/logs": ["logs"],
  "/api/ingest/errors": ["errors"],
  "/api/ingest/traces": ["traces"],
  "/api/ingest/custom-metrics": ["metrics"],
  "/api/ingest/metrics": ["endpoints", "consumers"]
};
var DEFAULT_BUFFER = {
  maxRequestLogs: 1e4,
  maxAppLogs: 1e4,
  maxErrors: 5000,
  maxTraces: 5000
};
var RESERVOIR_SIZE = 4096;
var MAX_CONSUMER_ROWS = 20000;
var DEFAULT_SEND_TIMEOUT_MS = 1e4;
function pushBounded(buffer, items, limit) {
  for (const item of items)
    buffer.push(item);
  const slack = Math.max(16, Math.floor(limit / 10));
  if (buffer.length > limit + slack)
    return trimTo(buffer, limit);
  return 0;
}
function trimTo(buffer, limit) {
  const over = buffer.length - limit;
  if (over <= 0)
    return 0;
  buffer.splice(0, over);
  return over;
}
function chunk(items, size) {
  if (items.length <= size)
    return [items];
  const out = [];
  for (let i = 0;i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
function chunkTraces(traces) {
  const out = [];
  let current = [];
  let spans = 0;
  for (const trace of traces) {
    const n = Array.isArray(trace.spans) ? trace.spans.length : 0;
    if (current.length && (current.length >= MAX_TRACES_PER_BATCH || spans + n > MAX_SPANS_PER_BATCH)) {
      out.push(current);
      current = [];
      spans = 0;
    }
    current.push(trace);
    spans += n;
  }
  if (current.length)
    out.push(current);
  return out;
}
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), ms);
    timer?.unref?.();
    return controller.signal;
  } catch {
    return;
  }
}

class MetricsCollector {
  endpointMetrics = new Map;
  consumerMetrics = new Map;
  requestLogBuffer = [];
  appLogBuffer = [];
  errorBuffer = [];
  traceBuffer = [];
  flushTimer = null;
  options;
  limits;
  sendTimeoutMs;
  dropped = { requestLogs: 0, appLogs: 0, errors: 0, traces: 0, consumers: 0 };
  warned = new Set;
  retries = new Map;
  inFlight = null;
  followUp = null;
  finalFlush = false;
  started = false;
  lastCpuUsage;
  lastCpuTime;
  constructor(options) {
    this.options = options;
    this.limits = { ...DEFAULT_BUFFER };
    for (const [k, v] of Object.entries(options.buffer ?? {})) {
      if (typeof v === "number" && v >= 0)
        this.limits[k] = v;
    }
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }
  start() {
    if (this.started)
      return;
    this.started = true;
    const interval = this.options.flushInterval || 30000;
    this.flushTimer = setInterval(() => void this.flush(), interval);
    this.flushTimer?.unref?.();
    registerCollector(this, this.options);
    this.log("Collector started, flushing every", interval, "ms");
  }
  async stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    unregisterCollector(this);
    this.started = false;
    await this.finalFlushNow();
    this.log("Collector stopped");
  }
  async finalFlushNow() {
    if (this.inFlight)
      await this.inFlight.catch(() => {});
    this.finalFlush = true;
    try {
      await this.flush();
    } finally {
      this.finalFlush = false;
    }
  }
  hasPendingData() {
    return this.endpointMetrics.size > 0 || this.requestLogBuffer.length > 0 || this.appLogBuffer.length > 0 || this.errorBuffer.length > 0 || this.traceBuffer.length > 0 || metricRegistry().size > 0;
  }
  recordRequest(data) {
    const route = normaliseRoutePath(data.path);
    const key = `${data.method}:${route}`;
    const isError = data.statusCode >= 400;
    const time = Number.isFinite(data.responseTime) ? data.responseTime : 0;
    let metrics = this.endpointMetrics.get(key);
    if (!metrics) {
      metrics = {
        method: data.method,
        path: route,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        responseTimes: [],
        totalResponseTime: 0,
        minResponseTime: time,
        maxResponseTime: time,
        statusCodes: {},
        totalRequestSize: 0,
        totalResponseSize: 0
      };
      this.endpointMetrics.set(key, metrics);
    }
    metrics.requestCount++;
    if (isError)
      metrics.errorCount++;
    else
      metrics.successCount++;
    metrics.totalResponseTime += time;
    if (time < metrics.minResponseTime)
      metrics.minResponseTime = time;
    if (time > metrics.maxResponseTime)
      metrics.maxResponseTime = time;
    if (metrics.responseTimes.length < RESERVOIR_SIZE) {
      metrics.responseTimes.push(time);
    } else {
      const j = Math.floor(Math.random() * metrics.requestCount);
      if (j < RESERVOIR_SIZE)
        metrics.responseTimes[j] = time;
    }
    metrics.totalRequestSize += data.requestSize || 0;
    metrics.totalResponseSize += data.responseSize || 0;
    const statusKey = String(data.statusCode);
    metrics.statusCodes[statusKey] = (metrics.statusCodes[statusKey] || 0) + 1;
    if (data.consumerIdentifier) {
      const consumerKey = `${data.consumerIdentifier}:${data.method}:${route}`;
      let cMetrics = this.consumerMetrics.get(consumerKey);
      if (!cMetrics) {
        if (this.consumerMetrics.size >= MAX_CONSUMER_ROWS) {
          this.dropped.consumers++;
          return;
        }
        cMetrics = {
          consumerIdentifier: data.consumerIdentifier,
          consumerName: data.consumerName,
          consumerGroup: data.consumerGroup,
          method: data.method,
          path: route,
          requestCount: 0,
          errorCount: 0,
          totalResponseTime: 0
        };
        this.consumerMetrics.set(consumerKey, cMetrics);
      }
      cMetrics.requestCount++;
      if (isError)
        cMetrics.errorCount++;
      cMetrics.totalResponseTime += time;
    }
  }
  recordError(error) {
    this.dropped.errors += pushBounded(this.errorBuffer, [error], this.limits.maxErrors);
  }
  recordRequestLog(entry) {
    this.dropped.requestLogs += pushBounded(this.requestLogBuffer, [entry], this.limits.maxRequestLogs);
  }
  recordAppLogs(logs) {
    if (logs.length)
      this.dropped.appLogs += pushBounded(this.appLogBuffer, logs, this.limits.maxAppLogs);
  }
  recordTrace(trace) {
    this.dropped.traces += pushBounded(this.traceBuffer, [trace], this.limits.maxTraces);
  }
  flush() {
    if (this.inFlight) {
      if (!this.followUp) {
        this.followUp = this.inFlight.catch(() => {}).then(() => {
          this.followUp = null;
          return this.flush();
        });
      }
      return this.followUp;
    }
    const run = this.doFlush().finally(() => {
      if (this.inFlight === run)
        this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }
  async doFlush() {
    try {
      const promises = [];
      const base = {
        appName: this.options.appName,
        module: this.options.module,
        env: this.options.env || "dev"
      };
      this.dropped.requestLogs += trimTo(this.requestLogBuffer, this.limits.maxRequestLogs);
      this.dropped.appLogs += trimTo(this.appLogBuffer, this.limits.maxAppLogs);
      this.dropped.errors += trimTo(this.errorBuffer, this.limits.maxErrors);
      this.dropped.traces += trimTo(this.traceBuffer, this.limits.maxTraces);
      this.reportDrops();
      promises.push(this.drainRetries(this.finalFlush));
      if (this.endpointMetrics.size > 0) {
        const payload = this.buildMetricsPayload();
        this.endpointMetrics.clear();
        this.consumerMetrics.clear();
        const endpointChunks = chunk(payload.endpoints, MAX_ENDPOINTS_PER_BATCH);
        const consumerChunks = chunk(payload.consumers, MAX_CONSUMERS_PER_BATCH);
        const n = Math.max(endpointChunks.length, consumerChunks.length);
        for (let i = 0;i < n; i++) {
          const part = {
            ...payload,
            endpoints: endpointChunks[i] ?? [],
            consumers: consumerChunks[i] ?? []
          };
          if (i > 0)
            delete part.resourceUsage;
          promises.push(this.sendToServer("/api/ingest/metrics", part));
        }
      }
      if (this.requestLogBuffer.length > 0) {
        const logs = this.requestLogBuffer.splice(0, this.requestLogBuffer.length);
        for (const part of chunk(logs, MAX_REQUESTS_PER_BATCH)) {
          const payload = { ...base, requests: part };
          promises.push(this.sendToServer("/api/ingest/requests", payload));
        }
      }
      if (this.appLogBuffer.length > 0) {
        const logs = this.appLogBuffer.splice(0, this.appLogBuffer.length);
        for (const part of chunk(logs, MAX_LOGS_PER_BATCH)) {
          const payload = { ...base, logs: part };
          promises.push(this.sendToServer("/api/ingest/logs", payload));
        }
      }
      if (this.errorBuffer.length > 0) {
        const errors = this.errorBuffer.splice(0, this.errorBuffer.length);
        for (const part of chunk(errors, MAX_ERRORS_PER_BATCH)) {
          const payload = { ...base, errors: part };
          promises.push(this.sendToServer("/api/ingest/errors", payload));
        }
      }
      if (this.traceBuffer.length > 0) {
        const traces = this.traceBuffer.splice(0, this.traceBuffer.length);
        for (const part of chunkTraces(traces)) {
          const payload = { ...base, traces: part };
          promises.push(this.sendToServer("/api/ingest/traces", payload));
        }
      }
      const points = metricRegistry().drain();
      if (points.length) {
        for (const part of chunk(points, MAX_CUSTOM_METRICS_PER_BATCH)) {
          promises.push(this.sendToServer("/api/ingest/custom-metrics", {
            ...base,
            version: this.options.version,
            metrics: part
          }));
        }
      }
      await Promise.allSettled(promises);
    } catch (err) {
      this.log("Flush error:", err);
    }
  }
  reportDrops() {
    const d = this.dropped;
    const parts = [];
    if (d.requestLogs)
      parts.push(`${d.requestLogs} request logs`);
    if (d.appLogs)
      parts.push(`${d.appLogs} app logs`);
    if (d.errors)
      parts.push(`${d.errors} errors`);
    if (d.traces)
      parts.push(`${d.traces} traces`);
    if (d.consumers)
      parts.push(`${d.consumers} consumer rows`);
    if (!parts.length)
      return;
    console.warn(`[sentrinel] buffers were full since the last flush — dropped the oldest ${parts.join(", ")}. ` + `Lower requestLogging.sampleRate or flushInterval, or raise the buffer limits.`);
    this.dropped = { requestLogs: 0, appLogs: 0, errors: 0, traces: 0, consumers: 0 };
  }
  buildMetricsPayload() {
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const elapsedTime = currentTime - this.lastCpuTime;
    const totalCpuMicros = currentCpuUsage.user + currentCpuUsage.system;
    const cpuUsagePercent = elapsedTime > 0 ? totalCpuMicros / (elapsedTime * 10) : 0;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = currentTime;
    const memUsage = process.memoryUsage();
    const endpoints = Array.from(this.endpointMetrics.values()).map((m) => {
      const sorted = m.responseTimes.slice().sort((a, b) => a - b);
      const len = sorted.length;
      return {
        method: m.method,
        path: m.path,
        requestCount: m.requestCount,
        successCount: m.successCount,
        errorCount: m.errorCount,
        avgResponseTime: m.requestCount > 0 ? m.totalResponseTime / m.requestCount : 0,
        minResponseTime: m.requestCount > 0 ? m.minResponseTime : 0,
        maxResponseTime: m.requestCount > 0 ? m.maxResponseTime : 0,
        p50ResponseTime: len > 0 ? percentile2(sorted, 0.5) : 0,
        p95ResponseTime: len > 0 ? percentile2(sorted, 0.95) : 0,
        p99ResponseTime: len > 0 ? percentile2(sorted, 0.99) : 0,
        totalRequestSize: m.totalRequestSize,
        totalResponseSize: m.totalResponseSize,
        statusCodes: m.statusCodes
      };
    });
    const distinctConsumers = new Set(Array.from(this.consumerMetrics.values()).map((c) => c.consumerIdentifier)).size;
    const totalRequests = Array.from(this.endpointMetrics.values()).reduce((sum, e) => sum + e.requestCount, 0);
    if (totalRequests >= 50 && distinctConsumers > totalRequests * 0.8) {
      this.warnOnce("consumer-cardinality", `${distinctConsumers} distinct consumers across ${totalRequests} requests — ` + "consumerIdentifier looks like it is returning something per-request " + "(a session or request id). It must be stable for the same user, or the " + "consumers table grows without bound.");
    }
    const consumers = Array.from(this.consumerMetrics.values()).map((c) => ({
      identifier: c.consumerIdentifier,
      ...c.consumerName ? { name: c.consumerName } : {},
      ...c.consumerGroup ? { group: c.consumerGroup } : {},
      method: c.method,
      path: c.path,
      requestCount: c.requestCount,
      errorCount: c.errorCount,
      totalResponseTime: c.totalResponseTime
    }));
    return {
      appName: this.options.appName,
      module: this.options.module,
      env: this.options.env || "dev",
      version: this.options.version,
      timestamp: new Date().toISOString(),
      endpoints,
      consumers,
      resourceUsage: {
        instanceId: INSTANCE_ID,
        cpuUsage: cpuUsagePercent,
        memoryRss: memUsage.rss,
        memoryHeapTotal: memUsage.heapTotal,
        memoryHeapUsed: memUsage.heapUsed
      }
    };
  }
  retryQueueFor(path) {
    let q = this.retries.get(path);
    if (!q) {
      q = new RetryQueue({
        maxQueued: this.options.retry?.maxQueued,
        maxQueuedBytes: this.options.retry?.maxQueuedBytes,
        maxAttempts: this.options.retry?.maxAttempts,
        baseDelayMs: this.options.retry?.baseDelayMs
      });
      this.retries.set(path, q);
    }
    return q;
  }
  async sendToServer(path, payload, attempts = 0) {
    const url = `${this.options.serverUrl}${path}`;
    let body;
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      this.warnOnce(`serialize:${path}`, `could not serialize a ${path} batch — ${err?.message}`);
      return;
    }
    try {
      const headers = {
        "Content-Type": "application/json"
      };
      if (this.options.apiKey) {
        headers["X-API-Key"] = this.options.apiKey;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: timeoutSignal(this.sendTimeoutMs)
      });
      if (res.status === 413) {
        await res.text().catch(() => "");
        const halves = splitPayload(path, payload);
        if (halves) {
          await Promise.allSettled(halves.map((half) => this.sendToServer(path, half, attempts)));
        } else {
          this.warnOnce(`413:${path}`, `a single ${path} record was refused as too large (413) and dropped.`);
        }
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const detail = text.slice(0, 300);
        if (res.status === 401 || res.status === 403) {
          this.warnOnce(`${path}`, `telemetry rejected (${res.status}). Check apiKey and env — ` + `the key must be issued for this environment. Server said: ${detail}`);
        } else if (res.status === 429) {
          this.warnOnce(`${path}`, `over quota (429) — telemetry is being dropped. ${detail}`);
        } else {
          this.warnOnce(`${path}`, `send failed: ${res.status} ${res.statusText}. ${detail}`);
        }
        if (!this.finalFlush)
          this.retryQueueFor(path).enqueue(path, payload, res.status, attempts, body.length);
        return;
      }
      this.warned.delete(path);
      this.warned.delete(`connect:${path}`);
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      this.warnOnce(`connect:${path}`, timedOut ? `the Sentrinel server at ${url} did not answer within ${this.sendTimeoutMs}ms` : `cannot reach the Sentrinel server at ${url} — ${err?.message ?? err}`);
      if (!this.finalFlush)
        this.retryQueueFor(path).enqueue(path, payload, undefined, attempts, body.length);
    }
  }
  async drainRetries(all = false) {
    const due = [...this.retries.values()].flatMap((q) => all ? q.takeAll() : q.due());
    if (due.length) {
      await Promise.allSettled(due.map((item) => this.sendToServer(item.path, item.body, item.attempts)));
    }
    let space = 0;
    let attempts = 0;
    for (const q of this.retries.values()) {
      const d = q.drainDropCounts();
      space += d.space;
      attempts += d.attempts;
    }
    if (space || attempts) {
      console.warn(`[sentrinel] dropped telemetry: ${space} over queue limit, ` + `${attempts} after exhausting retries`);
    }
  }
  get pendingRetries() {
    let n = 0;
    for (const q of this.retries.values())
      n += q.size;
    return n;
  }
  warnOnce(key, message) {
    if (this.warned.has(key))
      return;
    this.warned.add(key);
    console.warn(`[sentrinel] ${message}`);
  }
  log(...args) {
    if (this.options.debug) {
      console.log("[sentrinel]", ...args);
    }
  }
}
function splitPayload(path, payload) {
  const keys = SPLITTABLE[path];
  if (!keys || !payload || typeof payload !== "object")
    return null;
  const total = keys.reduce((n, k) => n + (Array.isArray(payload[k]) ? payload[k].length : 0), 0);
  if (total <= 1)
    return null;
  const first = { ...payload };
  const second = { ...payload };
  for (const key of keys) {
    const list = Array.isArray(payload[key]) ? payload[key] : [];
    const mid = Math.ceil(list.length / 2);
    first[key] = list.slice(0, mid);
    second[key] = list.slice(mid);
  }
  if ("resourceUsage" in second)
    delete second.resourceUsage;
  const nonEmpty = (p) => keys.some((k) => Array.isArray(p[k]) && p[k].length > 0);
  return [first, second].filter(nonEmpty);
}
function percentile2(sortedValues, p) {
  if (sortedValues.length === 0)
    return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

// src/sampling.ts
function shouldCaptureLog(statusCode, responseTimeMs, options, random = Math.random) {
  const rate = clampRate(options.sampleRate ?? 1);
  const slowMs = options.slowRequestThresholdMs ?? 2000;
  const mustKeep = statusCode >= 400 || responseTimeMs >= slowMs;
  if (mustKeep)
    return { capture: true, sampleRate: 1 };
  if (rate >= 1)
    return { capture: true, sampleRate: 1 };
  if (rate <= 0)
    return { capture: false, sampleRate: rate };
  return { capture: random() < rate, sampleRate: rate };
}
function clampRate(rate) {
  if (Number.isNaN(rate))
    return 1;
  return Math.min(1, Math.max(0, rate));
}

// src/logs.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var storage = new AsyncLocalStorage2;
var LEVEL_ORDER2 = { debug: 0, info: 1, warn: 2, error: 3 };
var patched = false;
var activeOptions = null;
function serialize(args, maxLen) {
  const text = args.map((a) => {
    if (typeof a === "string")
      return a;
    if (a instanceof Error)
      return `${a.name}: ${a.message}
${a.stack ?? ""}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}
function capture(level, args) {
  const opts = activeOptions;
  if (!opts)
    return;
  if (LEVEL_ORDER2[level] < LEVEL_ORDER2[opts.minLevel])
    return;
  const ctx = storage.getStore();
  if (!ctx)
    return;
  if (ctx.buffer.length >= opts.maxPerRequest) {
    ctx.dropped++;
    return;
  }
  ctx.buffer.push({
    timestamp: new Date().toISOString(),
    level,
    message: serialize(args, opts.maxMessageLength),
    requestId: ctx.requestId,
    seq: ctx.buffer.length
  });
}
function instrumentConsole(options) {
  activeOptions = {
    enabled: options.enabled,
    minLevel: options.minLevel ?? "info",
    maxPerRequest: options.maxPerRequest ?? 50,
    maxMessageLength: options.maxMessageLength ?? 2000
  };
  if (patched || !options.enabled)
    return;
  patched = true;
  const map = [
    ["debug", "debug"],
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"]
  ];
  for (const [method, level] of map) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        capture(level, args);
      } catch {}
      original(...args);
    };
  }
}
function createRequestLogContext(requestId) {
  return { requestId, buffer: [], dropped: 0 };
}
function enterRequestLogContext(ctx) {
  storage.enterWith(ctx);
}
function runWithRequestLogContext(ctx, fn) {
  return storage.run(ctx, fn);
}
function drainRequestLogs(ctx = storage.getStore()) {
  if (!ctx)
    return { logs: [], dropped: 0 };
  const logs = ctx.buffer;
  const dropped = ctx.dropped;
  ctx.buffer = [];
  ctx.dropped = 0;
  return { logs, dropped };
}

// src/client.ts
var IP_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "fly-client-ip",
  "x-client-ip",
  "x-forwarded-for"
];
var COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-geo-country",
  "fastly-client-country-code",
  "cloudfront-viewer-country"
];
function clientCountry(headers) {
  for (const h of COUNTRY_HEADERS) {
    const v = headers.get(h);
    if (!v)
      continue;
    const code = v.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1")
      return code;
  }
  return;
}
function clientIp(headers) {
  for (const h of IP_HEADERS) {
    const raw = headers.get(h);
    if (!raw)
      continue;
    const first = raw.split(",")[0]?.trim();
    if (first)
      return first.slice(0, 45);
  }
  return;
}
function requestHost(headers) {
  const h = headers.get("host");
  return h ? h.trim().slice(0, 255) : undefined;
}

// src/types.ts
function resolveConsumer(value) {
  if (!value)
    return { identifier: null };
  if (typeof value === "string")
    return { identifier: value };
  return {
    identifier: value.identifier || null,
    name: value.name,
    group: value.group
  };
}

// src/core.ts
var CONSUMER_HEADER = "x-sentrinel-consumer";
var DEVICE_HEADER = "x-sentrinel-device";
var MAX_HEADER_VALUE = 255;
function correlationFromContext() {
  const trace = traceStorage.getStore();
  return {
    requestId: currentRequestId(),
    traceId: trace?.traceId,
    spanId: trace?.currentSpanId
  };
}
function compileExcludes(paths) {
  return (paths || []).map((p) => typeof p === "string" ? new RegExp(`^${p.replace(/\*/g, ".*")}$`) : p);
}
function headersView(header) {
  return { get: (name) => header(name) ?? null };
}
function trustedHeaderConsumer(value, pattern) {
  if (!value)
    return;
  const v = value.trim();
  if (!v || v.length > MAX_HEADER_VALUE)
    return;
  if (/[\u0000-\u001f\u007f]/.test(v))
    return;
  if (/^guest:[A-Za-z0-9_.:-]{1,249}$/.test(v))
    return v;
  if (pattern) {
    pattern.lastIndex = 0;
    if (pattern.test(v))
      return v;
  }
  return;
}
function trustedDeviceId(value) {
  if (!value)
    return;
  const v = value.trim();
  if (!v || v.length > MAX_HEADER_VALUE)
    return;
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? v : undefined;
}
function getStatusMessage(code) {
  return STATUS_MESSAGES[code] || `HTTP ${code}`;
}
var STATUS_MESSAGES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
};
function statusFromName(name) {
  const wanted = name.trim().toLowerCase();
  for (const [code, message] of Object.entries(STATUS_MESSAGES)) {
    if (message.toLowerCase() === wanted)
      return Number(code);
  }
  return;
}
function errorShape(err) {
  if (err instanceof Error)
    return { name: err.name, message: err.message, stack: err.stack };
  if (err && typeof err === "object") {
    const e = err;
    if (typeof e.message === "string") {
      return {
        name: typeof e.name === "string" ? e.name : "Error",
        message: e.message,
        stack: typeof e.stack === "string" ? e.stack : undefined
      };
    }
  }
  if (err === undefined || err === null)
    return;
  return { name: "Error", message: String(err) };
}
function bodyText(body) {
  if (!body)
    return;
  if (typeof body.text === "string")
    return body.text;
  const v = body.value;
  if (v === undefined || v === null)
    return;
  if (typeof v === "string")
    return v;
  if (typeof v === "object") {
    if (typeof Response !== "undefined" && v instanceof Response)
      return;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)
      return;
    try {
      return JSON.stringify(v);
    } catch {
      return;
    }
  }
  return String(v);
}
function renderBody(body, maxBodySize, patterns) {
  if (!body)
    return;
  try {
    let masked;
    const v = body.value;
    if (body.text === undefined && v && typeof v === "object" && !(ArrayBuffer.isView(v) || v instanceof ArrayBuffer) && !(typeof Response !== "undefined" && v instanceof Response)) {
      masked = JSON.stringify(maskBodyFields(v, patterns));
    } else {
      const text = bodyText(body);
      if (!text)
        return;
      masked = maskBodyFields(text, patterns, body.contentType ?? undefined);
    }
    if (!masked || masked === "{}")
      return;
    if (body.truncated) {
      const marked = masked.length > maxBodySize ? masked.slice(0, maxBodySize) : masked;
      return `${marked}... [truncated${body.totalBytes ? `, ${body.totalBytes} bytes total` : ""}]`;
    }
    return truncateBody(masked, maxBodySize);
  } catch {
    return;
  }
}
function errorFromBody(body) {
  if (!body)
    return {};
  const v = body.value;
  if (v && typeof v === "object" && !(typeof Response !== "undefined" && v instanceof Response)) {
    const o = v;
    return {
      message: typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : undefined,
      type: typeof o.name === "string" ? o.name : typeof o.type === "string" ? o.type : undefined,
      stack: typeof o.stack === "string" ? o.stack : undefined
    };
  }
  const text = bodyText(body);
  if (!text)
    return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return {
        message: typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : undefined,
        type: typeof parsed.name === "string" ? parsed.name : typeof parsed.type === "string" ? parsed.type : undefined
      };
    }
  } catch {}
  return { message: text.slice(0, 500) };
}
function createServerInstrumentation(options, adapter) {
  const collector = new MetricsCollector(options);
  collector.start();
  const maxBodySize = options.requestLogging?.maxBodySize ?? 65536;
  const excludes = compileExcludes(options.excludePaths);
  if (options.logCapture?.enabled)
    instrumentConsole(options.logCapture);
  if (options.logging?.echo)
    setLogEcho(true);
  if (options.logging?.minLevel)
    setLogLevel(options.logging.minLevel);
  setCorrelationSource(correlationFromContext);
  const sink = (record2) => {
    collector.recordAppLogs([
      {
        timestamp: record2.timestamp,
        level: record2.level,
        message: record2.message,
        category: record2.category,
        attributes: record2.attributes,
        requestId: record2.requestId,
        traceId: record2.traceId,
        spanId: record2.spanId
      }
    ]);
  };
  setLogSink(sink);
  if (options.debug)
    console.log(`[sentrinel] ${adapter} instrumentation initialized for`, options.appName);
  const consumerFromHeader = (header) => typeof options.consumerIdentifier === "string" ? header(options.consumerIdentifier.toLowerCase()) : undefined;
  const begin = (method, url, header) => {
    const requestLogId = crypto.randomUUID();
    const incoming = parseTraceParent(header("traceparent")) ?? parseTraceParent(header("x-trace-id")) ?? parseTraceParent(header("x-request-id"));
    const rootSpanId = generateSpanId();
    const trace = {
      traceId: incoming?.traceId ?? generateTraceId(),
      rootSpanId,
      currentSpanId: rootSpanId,
      spans: [],
      inboundSpanId: incoming?.parentSpanId
    };
    let origin = {};
    try {
      const view = headersView(header);
      origin = { clientIp: clientIp(view), country: clientCountry(view), host: requestHost(view) };
    } catch {}
    return {
      requestLogId,
      startPerf: performance.now(),
      startISO: new Date().toISOString(),
      method: (method || "GET").toUpperCase(),
      url,
      trace,
      canonical: createCanonicalScope(),
      logCtx: options.logCapture?.enabled ? createRequestLogContext(requestLogId) : undefined,
      headerConsumer: trustedHeaderConsumer(header(CONSUMER_HEADER), options.consumerHeaderPattern),
      deviceId: trustedDeviceId(header(DEVICE_HEADER)),
      origin
    };
  };
  const run = (state, fn) => traceStorage.run(state.trace, () => runInRequestScope(state.requestLogId, sink, () => runInCanonicalScope(state.canonical, () => state.logCtx ? runWithRequestLogContext(state.logCtx, fn) : fn())));
  const enter = (state) => {
    traceStorage.enterWith(state.trace);
    enterRequestScope(state.requestLogId, sink);
    enterCanonicalScope(state.canonical);
    if (state.logCtx)
      enterRequestLogContext(state.logCtx);
  };
  const finish = (state, outcome) => {
    const responseTime = performance.now() - state.startPerf;
    const method = state.method;
    const pathname = state.url.pathname;
    const route = outcome.route || pathname;
    const statusCode = outcome.statusCode || 200;
    const resolved = resolveConsumer(outcome.consumer ?? null);
    const consumerIdentifier = resolved.identifier ?? state.headerConsumer ?? null;
    const consumerName = resolved.identifier ? resolved.name : undefined;
    const consumerGroup = resolved.identifier ? resolved.group : undefined;
    const requestSize = outcome.requestSize ?? 0;
    const responseSize = outcome.responseSize ?? 0;
    collector.recordRequest({
      method,
      path: route,
      statusCode,
      responseTime,
      requestSize,
      responseSize,
      consumerIdentifier,
      consumerName,
      consumerGroup
    });
    const canonical = drainCanonicalScope(state.canonical);
    const attributes = canonical || state.deviceId ? { ...canonical ?? {}, ...state.deviceId ? { "device.id": state.deviceId } : {} } : undefined;
    const requestLogId = state.requestLogId;
    const traceId = state.trace.traceId;
    let errorMessage;
    if (statusCode >= 400 || outcome.error) {
      let errorType;
      let stackTrace;
      if (outcome.error) {
        errorType = outcome.error.name;
        errorMessage = outcome.error.message;
        stackTrace = outcome.error.stack;
      } else {
        const fromBody = errorFromBody(outcome.responseBody);
        errorType = fromBody.type;
        errorMessage = fromBody.message;
        stackTrace = fromBody.stack;
      }
      collector.recordError({
        method,
        path: route,
        statusCode,
        statusMessage: getStatusMessage(statusCode),
        errorType,
        errorMessage,
        stackTrace,
        consumerIdentifier,
        timestamp: new Date().toISOString(),
        requestLogId,
        traceId,
        attributes
      });
    }
    const drained = state.logCtx ? drainRequestLogs(state.logCtx) : { logs: [], dropped: 0 };
    const hasErrorLogs = drained.logs.some((l) => l.level === "error");
    if (drained.logs.length) {
      collector.recordAppLogs(consumerIdentifier ? drained.logs.map((l) => ({ ...l, consumerIdentifier })) : drained.logs);
    }
    const startMs = new Date(state.startISO).getTime();
    const endTime = new Date(startMs + responseTime).toISOString();
    const durationMs = Math.round(responseTime * 100) / 100;
    const trace = state.trace;
    collector.recordTrace({
      traceId,
      requestLogId,
      name: `${method} ${route}`,
      startTime: state.startISO,
      endTime,
      durationMs,
      statusCode,
      spans: [
        {
          id: trace.rootSpanId,
          traceId,
          parentId: trace.inboundSpanId ?? null,
          name: `${method} ${route}`,
          kind: "SERVER",
          startTime: state.startISO,
          endTime,
          durationMs,
          statusCode: statusCode >= 500 || outcome.error ? "ERROR" : "OK",
          ...outcome.error ? { statusMessage: outcome.error.message } : {},
          attributes: {
            "sentrinel.source": "backend",
            "http.method": method,
            "http.route": route,
            "http.status_code": statusCode,
            ...consumerIdentifier ? { "sentrinel.consumer": consumerIdentifier } : {},
            ...state.deviceId ? { "device.id": state.deviceId } : {},
            ...trace.droppedSpans ? { "sentrinel.dropped_spans": trace.droppedSpans } : {}
          }
        },
        ...trace.spans
      ]
    });
    const logging = options.requestLogging;
    if (!logging?.enabled)
      return;
    const decision = shouldCaptureLog(statusCode, responseTime, logging);
    if (!decision.capture && !hasErrorLogs)
      return;
    const entry = {
      id: requestLogId,
      method,
      path: pathname,
      route,
      statusCode,
      responseTime: durationMs,
      requestSize,
      responseSize,
      env: options.env || "dev",
      consumerIdentifier,
      timestamp: state.startISO,
      sampleRate: hasErrorLogs ? 1 : decision.sampleRate,
      traceId,
      attributes,
      ...state.origin
    };
    if (logging.logRequestHeaders && outcome.requestHeaders) {
      try {
        entry.requestHeaders = maskHeaders(outcome.requestHeaders(), logging.maskHeaders);
      } catch {}
    }
    const query = {};
    state.url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    if (Object.keys(query).length)
      entry.queryParams = maskQueryParams(query, logging.maskQueryParams);
    if (logging.logRequestBody) {
      entry.requestBody = renderBody(outcome.requestBody, maxBodySize, logging.maskBodyFields);
    }
    if (logging.logResponseBody) {
      entry.responseBody = renderBody(outcome.responseBody, maxBodySize, logging.maskBodyFields);
    }
    if (statusCode >= 400 && errorMessage)
      entry.errorMessage = errorMessage;
    collector.recordRequestLog(entry);
  };
  return {
    collector,
    options,
    maxBodySize,
    isExcludedPath: (pathname) => excludes.some((p) => p.test(pathname)),
    begin,
    run,
    enter,
    consumerFromHeader,
    finish,
    flush: () => collector.flush(),
    stop: () => collector.stop()
  };
}
function flattenNodeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined)
      continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
function nodeHeaderGetter(headers) {
  return (name) => {
    const v = headers[name.toLowerCase()];
    if (v === undefined)
      return;
    return Array.isArray(v) ? v[0] : String(v);
  };
}

export { isCapturableBody, peekBody, MetricRegistry, metricRegistry, count, gauge, histogram, metric, flushAll, maskQueryParams, maskHeaders, maskBodyFields, maskUrl, withContext, addContext, currentContext, clearRequestScope, addRequestContext, setLogEcho, setLogLevel, getLogger, logger, statusFromName, errorShape, createServerInstrumentation, flattenNodeHeaders, nodeHeaderGetter };
