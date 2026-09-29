// ─── Process-level hooks ─────────────────────────────────────────────────────
//
// Two gaps this closes:
//
//   1. **The last window was lost on every deploy.** Buffers flush on a timer,
//      so a SIGTERM from the orchestrator — the normal end of every pod — threw
//      away up to a full flush interval of requests, and with them the errors
//      that usually explain *why* the deploy was happening.
//
//   2. **Crashes were never reported.** An exception that escapes every
//      handler kills the process, which is the single most important thing to
//      have in a monitoring tool and the one thing it never saw.
//
// Both are done without changing what the process would have done anyway.
// Adding a listener for SIGTERM, `uncaughtException` or `unhandledRejection`
// *disables* Node's default for that event, so each handler re-creates the
// default when no one else has registered for it: the signal is re-raised, the
// crash still prints and exits with code 1. When the app has handlers of its
// own, they decide — this only records and flushes.
//
// Registered once per process, however many collectors exist (a process can
// host several instrumented apps), and kept on globalThis so a dev server's
// module reload does not stack a second set.

export interface Flushable {
  flush(): Promise<void>;
  finalFlushNow(): Promise<void>;
  hasPendingData(): boolean;
  recordError(error: any): void;
}

interface HookSettings {
  flushOnExit: boolean;
  captureErrors: boolean;
  timeoutMs: number;
}

interface Registry {
  collectors: Map<Flushable, HookSettings>;
  installed: { signals: boolean; exit: boolean; errors: boolean };
  reported: WeakSet<object>;
  exiting: boolean;
}

const KEY = Symbol.for("sentrinel.processHooks");

function registry(): Registry {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      collectors: new Map(),
      installed: { signals: false, exit: false, errors: false },
      reported: new WeakSet(),
      exiting: false,
    } satisfies Registry;
  }
  return g[KEY];
}

function settingsFrom(options: { processHooks?: unknown }): HookSettings | null {
  const raw = options.processHooks as
    | boolean
    | { flushOnExit?: boolean; captureErrors?: boolean; timeoutMs?: number }
    | undefined;
  if (raw === false) return null;
  // A test runner owns its process: an exit(1) from a captured exception
  // would take the whole suite down. Explicit `processHooks` still wins.
  if (raw === undefined && typeof process !== "undefined" && process.env?.NODE_ENV === "test") return null;
  const obj = typeof raw === "object" && raw ? raw : {};
  return {
    flushOnExit: obj.flushOnExit !== false,
    captureErrors: obj.captureErrors !== false,
    timeoutMs: typeof obj.timeoutMs === "number" && obj.timeoutMs >= 0 ? obj.timeoutMs : 3_000,
  };
}

function hasProcessEvents(): boolean {
  return typeof process !== "undefined" && typeof process.on === "function" && typeof process.listenerCount === "function";
}

export function registerCollector(collector: Flushable, options: { processHooks?: unknown }): void {
  const settings = settingsFrom(options);
  if (!settings || !hasProcessEvents()) return;
  const reg = registry();
  reg.collectors.set(collector, settings);
  if (settings.flushOnExit) installExitHooks(reg);
  if (settings.captureErrors) installErrorHooks(reg);
}

export function unregisterCollector(collector: Flushable): void {
  if (!hasProcessEvents()) return;
  registry().collectors.delete(collector);
}

function longestTimeout(reg: Registry): number {
  let max = 0;
  for (const s of reg.collectors.values()) max = Math.max(max, s.timeoutMs);
  return max;
}

/** Flush every live collector, giving up after `timeoutMs`. Never rejects. */
export async function flushAll(timeoutMs = longestTimeout(registry())): Promise<void> {
  const reg = registry();
  const flushes = [...reg.collectors.keys()].map((c) => c.finalFlushNow().catch(() => {}));
  if (!flushes.length) return;
  let timer: any;
  await Promise.race([
    Promise.allSettled(flushes),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer?.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

// ─── Signals and exit ────────────────────────────────────────────────────────

function installExitHooks(reg: Registry): void {
  if (!reg.installed.signals) {
    reg.installed.signals = true;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        const alone = process.listenerCount(signal) <= 1;
        void flushAll().finally(() => {
          // Nobody else handles this signal, so our listener is the only thing
          // standing between it and Node's default — exit. Step aside and let
          // the signal do what it would have done.
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
    // The event loop drained: a script or worker finished normally. Flushing
    // schedules more work, after which beforeExit fires again — by then the
    // buffers are empty and the final flush re-queues nothing, so this
    // settles instead of looping.
    process.on("beforeExit", () => {
      if (reg.exiting) return;
      const pending = [...reg.collectors.keys()].some((c) => c.hasPendingData());
      if (pending) void flushAll();
    });
  }
}

// ─── Crashes ─────────────────────────────────────────────────────────────────

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === "string" ? reason : `Non-Error rejection: ${safeString(reason)}`
  );
  err.name = "UnhandledRejection";
  return err;
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(reg: Registry, err: Error, origin: string): void {
  if (reg.reported.has(err)) return;
  reg.reported.add(err);
  // The first collector registered, as with logs outside a request: in a
  // process hosting several apps there is no better owner for a crash, and
  // recording it in every one would count it several times.
  const first = reg.collectors.keys().next().value as Flushable | undefined;
  if (!first) return;
  try {
    first.recordError({
      // No HTTP exchange; `varchar(10)` on the server, so short.
      method: "PROCESS",
      path: origin,
      statusCode: 0,
      statusMessage: origin === "unhandledRejection" ? "Unhandled rejection" : "Uncaught exception",
      errorType: err.name || "Error",
      errorMessage: String(err.message ?? "").slice(0, 2_000),
      stackTrace: typeof err.stack === "string" ? err.stack.slice(0, 16_000) : undefined,
      timestamp: new Date().toISOString(),
      attributes: { "error.handled": false, "error.mechanism": origin },
    });
  } catch {
    // Recording must never be the thing that fails during a crash.
  }
}

/** Node's `--unhandled-rejections` mode, from the command line or NODE_OPTIONS. */
function rejectionMode(): string {
  const args = [...(process.execArgv ?? []), ...String(process.env?.NODE_OPTIONS ?? "").split(/\s+/)];
  for (const a of args) {
    const m = /^--unhandled-rejections=(\S+)$/.exec(a);
    if (m) return m[1];
  }
  return "throw";
}

function installErrorHooks(reg: Registry): void {
  if (reg.installed.errors) return;
  reg.installed.errors = true;

  const onUncaught = (error: unknown, origin?: string) => {
    const err = toError(error);
    record(reg, err, origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException");

    // Someone else handles crashes; they decide whether the process lives.
    if (process.listenerCount("uncaughtException") > 1) {
      void flushAll();
      return;
    }

    // Otherwise, do what Node would have done — print and exit(1) — after
    // giving the report a bounded chance to leave.
    if (reg.exiting) return;
    reg.exiting = true;
    try {
      process.stderr.write(`${err.stack ?? `${err.name}: ${err.message}`}\n`);
    } catch {
      // stderr closed: nothing to print to.
    }
    process.exitCode = 1;
    void flushAll().finally(() => process.exit(1));
  };

  const onRejection = (reason: unknown) => {
    const err = toError(reason);
    record(reg, err, "unhandledRejection");
    if (process.listenerCount("unhandledRejection") > 1) return;

    const mode = rejectionMode();
    if (mode === "none") return;
    if (mode === "warn" || mode === "warn-with-error-code") {
      if (mode === "warn-with-error-code") process.exitCode = 1;
      try {
        process.stderr.write(`Unhandled promise rejection: ${err.stack ?? err.message}\n`);
      } catch {}
      return;
    }
    // `throw` (the default) and `strict`: Node raises the rejection as an
    // uncaught exception, which reaches the app's own uncaughtException
    // handlers if it has any. Emitting it reproduces exactly that.
    // Typed loosely on purpose: the overloads only admit the declared events,
    // and this re-raises one as another.
    (process.emit as (event: string, ...args: unknown[]) => boolean)("uncaughtException", err, "unhandledRejection");
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
}

/** Test seam: which collectors the hooks will flush. */
export function registeredCollectorCount(): number {
  return hasProcessEvents() ? registry().collectors.size : 0;
}
