// ─── Application-log capture ─────────────────────────────────────────────────
//
// Patches console.{log,info,warn,error,debug} once and, while a request is
// being handled, copies each line into that request's buffer (correlated via
// AsyncLocalStorage). Console output still reaches stdout untouched.
//
// Design notes:
//  * enterWith() is used from Elysia's derive hook — each incoming request
//    starts a fresh async context in Bun, so buffers do not leak across
//    concurrent requests.
//  * Capture is bounded (maxPerRequest) and messages truncated, so a noisy
//    loop cannot balloon memory or payloads.

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CapturedLog {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  /** Position within the request — keeps same-millisecond lines ordered. */
  seq?: number;
}

export interface LogCaptureOptions {
  /** Enable console capture during request handling (default: false). */
  enabled: boolean;
  /** Minimum level to capture (default: "info"; "debug" captures everything). */
  minLevel?: LogLevel;
  /** Cap per request so a hot loop can't flood the buffer (default: 50). */
  maxPerRequest?: number;
  /** Truncate individual messages to this many chars (default: 2000). */
  maxMessageLength?: number;
}

interface RequestLogContext {
  requestId: string;
  buffer: CapturedLog[];
  dropped: number;
}

const storage = new AsyncLocalStorage<RequestLogContext>();
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let patched = false;
let activeOptions: Required<LogCaptureOptions> | null = null;

function serialize(args: unknown[], maxLen: number): string {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function capture(level: LogLevel, args: unknown[]) {
  const opts = activeOptions;
  if (!opts) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[opts.minLevel]) return;
  const ctx = storage.getStore();
  if (!ctx) return; // not inside a monitored request
  if (ctx.buffer.length >= opts.maxPerRequest) {
    ctx.dropped++;
    return;
  }
  ctx.buffer.push({
    timestamp: new Date().toISOString(),
    level,
    message: serialize(args, opts.maxMessageLength),
    requestId: ctx.requestId,
    seq: ctx.buffer.length,
  });
}

/** Patch console once. Idempotent; original behaviour is preserved. */
export function instrumentConsole(options: LogCaptureOptions) {
  activeOptions = {
    enabled: options.enabled,
    minLevel: options.minLevel ?? "info",
    maxPerRequest: options.maxPerRequest ?? 50,
    maxMessageLength: options.maxMessageLength ?? 2000,
  };
  if (patched || !options.enabled) return;
  patched = true;

  const map: Array<[keyof Console, LogLevel]> = [
    ["debug", "debug"],
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of map) {
    const original = (console[method] as (...a: unknown[]) => void).bind(console);
    (console as any)[method] = (...args: unknown[]) => {
      try {
        capture(level, args);
      } catch {}
      original(...args);
    };
  }
}

/** Called from the plugin's derive hook: opens this request's log context. */
export function beginRequestLogContext(requestId: string) {
  storage.enterWith({ requestId, buffer: [], dropped: 0 });
}

/** Called from afterResponse: drains and returns this request's lines. */
export function drainRequestLogs(): { logs: CapturedLog[]; dropped: number } {
  const ctx = storage.getStore();
  if (!ctx) return { logs: [], dropped: 0 };
  const logs = ctx.buffer;
  const dropped = ctx.dropped;
  ctx.buffer = [];
  ctx.dropped = 0;
  return { logs, dropped };
}
