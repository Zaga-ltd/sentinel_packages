// ─── Structured, trace-connected logging ────────────────────────────────────
//
// The problem with conventional logging is that it optimises for *writing* —
// a human-readable sentence — when what you actually do with logs is *query*
// them. `console.log(\`user ${id} failed checkout\`)` is easy to write and
// impossible to ask questions of: you cannot filter by user, group by failure
// reason, or correlate it with the request that produced it.
//
// This logger takes the opposite position:
//
//   * A log is a **message plus attributes**, never an interpolated sentence.
//     `logger.warn("Checkout declined", { userId, reason, cartTotal })` is one
//     stable message you can group by, with high-cardinality fields you can
//     filter on.
//
//   * Every record is **automatically correlated** — request id, trace id and
//     span id are attached from the ambient context, so a log line always knows
//     which request and which span produced it. That is what makes "show me
//     everything that happened during this request" a lookup rather than a
//     grep.
//
//   * **Context is inherited, not repeated.** `withContext({ userId }, fn)`
//     attaches those fields to every log emitted anywhere inside `fn`, however
//     deep the call stack, so business context reaches logs written by code
//     that has never heard of a user.
//
//   * **Categories are hierarchical** (`["api", "checkout"]`), so you can filter
//     a whole subsystem without inventing a naming convention.
//
// Nothing here blocks the request path: records go into an in-memory buffer the
// collector flushes on its normal interval.

import { AsyncLocalStorage } from "node:async_hooks";
import type { LogLevel } from "./logs";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  /** The stable, low-cardinality message. Group by this. */
  message: string;
  /** Dotted category path, e.g. "api.checkout". */
  category?: string;
  /** Merged explicit attributes + inherited context. Filter by these. */
  attributes?: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  /** Ordering within a request when timestamps collide. */
  seq?: number;
}

/** Fields inherited by every log emitted inside a withContext() scope. */
export type LogContext = Record<string, unknown>;

const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with these fields attached to every log emitted inside it.
 *
 * Nested scopes merge, inner winning, so a request-level scope can set
 * `{ tenantId }` and a handler can add `{ orderId }` without either knowing
 * about the other.
 */
export function withContext<T>(fields: LogContext, fn: () => T): T {
  const parent = contextStorage.getStore() ?? {};
  return contextStorage.run({ ...parent, ...fields }, fn);
}

/**
 * Add fields to the *current* scope without nesting a callback.
 *
 * Useful in middleware that has no wrapping function to hand — but it only
 * affects the current async context, so prefer withContext() when you can.
 */
export function addContext(fields: LogContext): void {
  const store = contextStorage.getStore();
  if (store) Object.assign(store, fields);
}

/** The context that would be attached to a log right now. */
export function currentContext(): LogContext {
  return { ...(contextStorage.getStore() ?? {}) };
}

/** Opens a context scope for the remainder of this async execution. */
export function enterContext(fields: LogContext): void {
  contextStorage.enterWith({ ...(contextStorage.getStore() ?? {}), ...fields });
}

// ─── Correlation ────────────────────────────────────────────────────────────
//
// The plugin installs this so the logger can read the active request/trace
// without importing it and creating a cycle.

export interface Correlation {
  requestId?: string;
  traceId?: string;
  spanId?: string;
}

let correlationSource: (() => Correlation) | null = null;

export function setCorrelationSource(fn: () => Correlation): void {
  correlationSource = fn;
}

/**
 * The request a log belongs to, and which plugin instance owns it.
 *
 * Held separately from the trace context because the two have different
 * lifetimes: console capture and tracing can each be enabled on their own, and
 * background work has neither.
 *
 * The owning sink matters because a single process can host more than one
 * instrumented app — the demo cluster runs three in one process. With a single
 * global sink, whichever plugin initialised last would swallow every app's
 * logs and file them under its own name.
 */
interface RequestScope {
  requestId: string;
  sink?: LogSink;
}

const requestStorage = new AsyncLocalStorage<RequestScope>();

/** Opens the request scope for the rest of this async execution. */
export function enterRequestScope(requestId: string, sink?: LogSink): void {
  requestStorage.enterWith({ requestId, sink });
}

/**
 * Leave the request scope.
 *
 * enterWith() has no natural end — it persists for the remainder of the async
 * execution. That is what you want per request, but a worker that keeps running
 * after a request finishes would otherwise go on attributing its logs to it.
 */
export function clearRequestScope(): void {
  requestStorage.enterWith({ requestId: "" });
}

export function currentRequestId(): string | undefined {
  return requestStorage.getStore()?.requestId || undefined;
}

// ─── Canonical (wide) request events ────────────────────────────────────────
//
// Scattered log lines make you reassemble a request from fragments. A canonical
// event is the opposite: ONE row per request carrying everything worth knowing —
// the technical facts the plugin already records, plus whatever business context
// the handler chooses to attach.
//
// It is the single highest-value thing you can add to a request: "show me slow
// checkouts for enterprise customers with the new pricing flag" is a query
// against one table, not a correlation exercise.

const canonicalStorage = new AsyncLocalStorage<{ fields: Record<string, unknown> }>();

/** Opens the canonical-field collector for this request. */
export function beginCanonicalScope(): void {
  canonicalStorage.enterWith({ fields: {} });
}

/**
 * Attach business context to *this request's* canonical event.
 *
 * Call it anywhere in the handler, as many times as you like:
 *
 *   addRequestContext({ tier: user.tier, cartTotal, experiment: "new-pricing" });
 */
export function addRequestContext(fields: Record<string, unknown>): void {
  const store = canonicalStorage.getStore();
  if (store) Object.assign(store.fields, fields);
}

/** Drains the fields collected for this request. */
export function drainCanonicalFields(): Record<string, unknown> | undefined {
  const store = canonicalStorage.getStore();
  if (!store || !Object.keys(store.fields).length) return undefined;
  const fields = { ...store.fields };
  store.fields = {};
  return fields;
}

// ─── Sink ───────────────────────────────────────────────────────────────────

export type LogSink = (record: LogRecord) => void;

/**
 * The sink for logs written outside any request — startup, background jobs,
 * schedulers. The *first* plugin to register wins, because in a multi-app
 * process there is no better answer than "the app that booted first", and
 * silently reassigning it on every later registration is worse.
 */
let defaultSink: LogSink | null = null;
/** Records emitted before any plugin starts, so nothing is lost at boot. */
const pending: LogRecord[] = [];
const MAX_PENDING = 500;

export function setLogSink(fn: LogSink): void {
  if (!defaultSink) {
    defaultSink = fn;
    while (pending.length) fn(pending.shift()!);
  }
}

/** Test seam — lets a suite install a fresh sink. */
export function resetLogSink(): void {
  defaultSink = null;
  pending.length = 0;
}

/** Mirror records to stdout as JSON. Off by default — the app owns its output. */
let echo = false;
export function setLogEcho(on: boolean): void {
  echo = on;
}

let minLevel: LogLevel = "debug";
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * `{placeholder}` in a message is replaced from attributes or context.
 *
 * The *stored* message keeps its placeholders, so every occurrence groups
 * together no matter what the values were — the values are already in the
 * attributes, where they can be filtered. Interpolation is only for the
 * human-readable echo.
 */
function interpolate(message: string, values: Record<string, unknown>): string {
  return message.replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole
  );
}

function emit(
  level: LogLevel,
  category: string | undefined,
  message: string,
  attributes?: Record<string, unknown>
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const context = contextStorage.getStore();
  const merged =
    context || attributes ? { ...(context ?? {}), ...(attributes ?? {}) } : undefined;

  const correlation = correlationSource?.() ?? {};

  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    message,
    category,
    attributes: merged && Object.keys(merged).length ? merged : undefined,
    ...correlation,
  };

  if (echo) {
    // Human-readable line for local development; the structured record is what
    // gets shipped.
    const rendered = merged ? interpolate(message, merged) : message;
    const suffix = merged ? " " + JSON.stringify(merged) : "";
    const tag = category ? `[${category}] ` : "";
    process.stdout.write(`${record.timestamp} ${level.toUpperCase().padEnd(5)} ${tag}${rendered}${suffix}\n`);
  }

  // Inside a request, the log belongs to the app that is handling it — not to
  // whichever plugin happened to register last.
  const target = requestStorage.getStore()?.sink ?? defaultSink;
  if (target) target(record);
  else if (pending.length < MAX_PENDING) pending.push(record);
}

// ─── Logger ─────────────────────────────────────────────────────────────────

export interface Logger {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
  /**
   * A child logger under a nested category. `getLogger("api").getChild("auth")`
   * logs as "api.auth", so you can filter a subsystem or one route.
   */
  getChild(category: string | string[]): Logger;
  /** A logger whose records always carry these attributes. */
  with(attributes: Record<string, unknown>): Logger;
  readonly category: string;
}

function makeLogger(parts: string[], bound: Record<string, unknown>): Logger {
  const category = parts.join(".");

  const log =
    (level: LogLevel) =>
    (message: string, attributes?: Record<string, unknown>) => {
      const merged =
        Object.keys(bound).length || attributes ? { ...bound, ...(attributes ?? {}) } : undefined;
      emit(level, category || undefined, message, merged);
    };

  return {
    category,
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    getChild: (child) => makeLogger([...parts, ...toParts(child)], bound),
    with: (attributes) => makeLogger(parts, { ...bound, ...attributes }),
  };
}

function toParts(category: string | string[] | undefined): string[] {
  if (!category) return [];
  return Array.isArray(category) ? category.filter(Boolean) : category.split(".").filter(Boolean);
}

/**
 * Get a logger, optionally under a category.
 *
 *   const log = getLogger(["api", "checkout"]);
 *   log.info("Payment authorized", { orderId, amount, provider: "stripe" });
 *
 * Cheap to call — create one per module at import time, or inline.
 */
export function getLogger(category?: string | string[]): Logger {
  return makeLogger(toParts(category), {});
}

/** The root logger, for code that has nothing more specific to say. */
export const logger = getLogger();
