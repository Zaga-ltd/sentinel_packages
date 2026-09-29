import type {
  SentrinelPluginOptions,
  EndpointMetrics,
  ConsumerRequestMetrics,
  RequestLogEntry,
  MetricsPayload,
  RequestLogsPayload,
  ErrorPayload,
  AppLogsPayload,
  TraceRecord,
  TracesPayload,
} from "./types";
import { normaliseRoutePath } from "./route-path";
import { RetryQueue } from "./retry";
import { metricRegistry } from "./metrics";
import { registerCollector, unregisterCollector } from "./process-hooks";
import { hostname } from "node:os";

/**
 * Which process these metrics came from.
 *
 * Without it every instance of an app reports into one undifferentiated
 * stream, and the dashboard averages them — so a single instance pegged at
 * 100% CPU while three others idle shows as a comfortable 25%, and the one
 * that is about to fall over is invisible.
 *
 * Hostname plus pid: in a container the hostname is the container id, which is
 * exactly the granularity wanted, and the pid separates workers on a machine
 * running several. Computed once — os.hostname() is a syscall and this is on
 * the flush path.
 */
const INSTANCE_ID = (() => {
  try {
    return `${hostname()}:${process.pid}`.slice(0, 128);
  } catch {
    return `pid:${process.pid}`;
  }
})();

// ─── Server limits ──────────────────────────────────────────────────────────
//
// What one ingest call accepts. A batch over any of these is refused whole with
// a 413 — so a buffer that simply grew past 5,000 request logs between flushes
// (any app over ~167 requests a second on the default interval) lost every row
// of every flush, and the 413 was treated as permanent, so nothing was retried
// either. Batches are cut to these before they leave.

const MAX_REQUESTS_PER_BATCH = 5_000;
const MAX_LOGS_PER_BATCH = 5_000;
const MAX_ERRORS_PER_BATCH = 2_000;
const MAX_ENDPOINTS_PER_BATCH = 2_000;
const MAX_CONSUMERS_PER_BATCH = 5_000;
const MAX_CUSTOM_METRICS_PER_BATCH = 2_000;
const MAX_TRACES_PER_BATCH = 500;
const MAX_SPANS_PER_BATCH = 10_000;

/** Which arrays a payload can be halved along when the server still says 413. */
const SPLITTABLE: Record<string, string[]> = {
  "/api/ingest/requests": ["requests"],
  "/api/ingest/logs": ["logs"],
  "/api/ingest/errors": ["errors"],
  "/api/ingest/traces": ["traces"],
  "/api/ingest/custom-metrics": ["metrics"],
  "/api/ingest/metrics": ["endpoints", "consumers"],
};

// ─── Memory limits ──────────────────────────────────────────────────────────

const DEFAULT_BUFFER = {
  maxRequestLogs: 10_000,
  maxAppLogs: 10_000,
  maxErrors: 5_000,
  maxTraces: 5_000,
};

/** Response times kept per endpoint per window, for percentiles. */
const RESERVOIR_SIZE = 4_096;

/** Distinct consumer×route rows held per window. */
const MAX_CONSUMER_ROWS = 20_000;

const DEFAULT_SEND_TIMEOUT_MS = 10_000;

type DropCounts = {
  requestLogs: number;
  appLogs: number;
  errors: number;
  traces: number;
  consumers: number;
};

/**
 * Push onto a bounded buffer, dropping the oldest past `limit`.
 *
 * Trimmed in slabs rather than one `shift()` per push: at the limit a busy app
 * would otherwise move the whole array on every request. The array may run up
 * to ~10% over between trims; `trimTo` makes it exact at flush time.
 */
function pushBounded<T>(buffer: T[], items: T[], limit: number): number {
  for (const item of items) buffer.push(item);
  const slack = Math.max(16, Math.floor(limit / 10));
  if (buffer.length > limit + slack) return trimTo(buffer, limit);
  return 0;
}

function trimTo<T>(buffer: T[], limit: number): number {
  const over = buffer.length - limit;
  if (over <= 0) return 0;
  buffer.splice(0, over);
  return over;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Traces cut to both caps: trace count and total span count. */
function chunkTraces(traces: TraceRecord[]): TraceRecord[][] {
  const out: TraceRecord[][] = [];
  let current: TraceRecord[] = [];
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
  if (current.length) out.push(current);
  return out;
}

/** An AbortSignal that fires after `ms`, without holding the process open. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as any).timeout === "function") {
      return (AbortSignal as any).timeout(ms);
    }
    const controller = new AbortController();
    const timer: any = setTimeout(() => controller.abort(), ms);
    timer?.unref?.();
    return controller.signal;
  } catch {
    return undefined;
  }
}

// ─── Metrics Collector ──────────────────────────────────────────────────────────
// Buffers metrics in memory and flushes to the Sentrinel API server periodically

export class MetricsCollector {
  private endpointMetrics: Map<string, EndpointMetrics> = new Map();
  private consumerMetrics: Map<string, ConsumerRequestMetrics> = new Map();
  private requestLogBuffer: RequestLogEntry[] = [];
  private appLogBuffer: AppLogsPayload["logs"] = [];
  private errorBuffer: ErrorPayload["errors"] = [];
  private traceBuffer: TraceRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private options: SentrinelPluginOptions;
  private readonly limits: typeof DEFAULT_BUFFER;
  private readonly sendTimeoutMs: number;
  private dropped: DropCounts = { requestLogs: 0, appLogs: 0, errors: 0, traces: 0, consumers: 0 };
  /** Problems already reported, so a broken pipe warns once, not every flush. */
  private warned = new Set<string>();
  /**
   * Payloads a failed send is holding on to, one queue per payload type.
   *
   * One shared queue let an outage fill every slot with request-log batches,
   * which then evicted the small metrics batches every headline number is built
   * from. Separate budgets mean the cheap, important data survives the big,
   * sampled data.
   */
  private retries = new Map<string, RetryQueue>();
  /** The flush running now, if any. */
  private inFlight: Promise<void> | null = null;
  /** A flush requested while one was running; shared by every such caller. */
  private followUp: Promise<void> | null = null;
  /** Set during the last flush: failures are not re-queued, nothing will retry them. */
  private finalFlush = false;
  private started = false;

  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: number;

  constructor(options: SentrinelPluginOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_BUFFER };
    for (const [k, v] of Object.entries(options.buffer ?? {})) {
      if (typeof v === "number" && v >= 0) (this.limits as any)[k] = v;
    }
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }

  /** Start the periodic flush timer */
  start(): void {
    if (this.started) return;
    this.started = true;
    const interval = this.options.flushInterval || 30_000;
    this.flushTimer = setInterval(() => void this.flush(), interval);
    // A monitoring SDK must never be the reason a process cannot exit. A
    // server's listening socket keeps it alive anyway; a script or a worker
    // that has finished should end — and the beforeExit hook flushes first.
    (this.flushTimer as any)?.unref?.();
    registerCollector(this, this.options);
    this.log("Collector started, flushing every", interval, "ms");
  }

  /**
   * Stop the collector and perform a final flush.
   *
   * Waits for a flush already in flight, then sends what arrived since and
   * makes one last attempt at anything held for retry. It used to return early
   * when a flush was running, so a shutdown that coincided with the timer lost
   * the tail of the buffer.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    unregisterCollector(this);
    this.started = false;
    await this.finalFlushNow();
    this.log("Collector stopped");
  }

  /** One last flush that tries everything and re-queues nothing. */
  async finalFlushNow(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.finalFlush = true;
    try {
      await this.flush();
    } finally {
      this.finalFlush = false;
    }
  }

  /** Is anything waiting to be sent? */
  hasPendingData(): boolean {
    return (
      this.endpointMetrics.size > 0 ||
      this.requestLogBuffer.length > 0 ||
      this.appLogBuffer.length > 0 ||
      this.errorBuffer.length > 0 ||
      this.traceBuffer.length > 0 ||
      metricRegistry().size > 0
    );
  }

  /** Record a request metric */
  recordRequest(data: {
    method: string;
    path: string;
    statusCode: number;
    responseTime: number;
    requestSize: number;
    responseSize: number;
    consumerIdentifier?: string | null;
    consumerName?: string;
    consumerGroup?: string;
  }): void {
    // Ids collapsed before this becomes a key. Without it the map grows one
    // entry per request between flushes, and a batch carrying more than 2,000
    // endpoints is refused with a 413 — the whole flush lost, for exactly the
    // apps with the most traffic.
    const route = normaliseRoutePath(data.path);
    const key = `${data.method}:${route}`;
    const isError = data.statusCode >= 400;
    const time = Number.isFinite(data.responseTime) ? data.responseTime : 0;

    // Aggregate endpoint metrics
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
        totalResponseSize: 0,
      };
      this.endpointMetrics.set(key, metrics);
    }

    metrics.requestCount++;
    if (isError) metrics.errorCount++;
    else metrics.successCount++;
    metrics.totalResponseTime += time;
    if (time < metrics.minResponseTime) metrics.minResponseTime = time;
    if (time > metrics.maxResponseTime) metrics.maxResponseTime = time;
    // Reservoir sample: a hot endpoint used to push every response time into
    // an array for the whole window — hundreds of thousands of numbers at
    // high traffic. Each observation keeps an equal chance of being in the
    // sample, so the percentiles stay representative.
    if (metrics.responseTimes.length < RESERVOIR_SIZE) {
      metrics.responseTimes.push(time);
    } else {
      const j = Math.floor(Math.random() * metrics.requestCount);
      if (j < RESERVOIR_SIZE) metrics.responseTimes[j] = time;
    }
    metrics.totalRequestSize += data.requestSize || 0;
    metrics.totalResponseSize += data.responseSize || 0;

    const statusKey = String(data.statusCode);
    metrics.statusCodes[statusKey] = (metrics.statusCodes[statusKey] || 0) + 1;

    // Aggregate consumer metrics
    if (data.consumerIdentifier) {
      // Same route identity as the endpoint map above — this one is capped at
      // 5,000 per batch, and it multiplies by consumer.
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
          totalResponseTime: 0,
        };
        this.consumerMetrics.set(consumerKey, cMetrics);
      }
      cMetrics.requestCount++;
      if (isError) cMetrics.errorCount++;
      cMetrics.totalResponseTime += time;
    }
  }

  /** Record an error */
  recordError(error: ErrorPayload["errors"][0]): void {
    this.dropped.errors += pushBounded(this.errorBuffer, [error], this.limits.maxErrors);
  }

  /** Record a full request log entry */
  recordRequestLog(entry: RequestLogEntry): void {
    this.dropped.requestLogs += pushBounded(this.requestLogBuffer, [entry], this.limits.maxRequestLogs);
  }

  /** Record application log lines captured during a request */
  recordAppLogs(logs: AppLogsPayload["logs"]): void {
    if (logs.length) this.dropped.appLogs += pushBounded(this.appLogBuffer, logs, this.limits.maxAppLogs);
  }

  /** Record a completed trace (root span + any spans the handler recorded) */
  recordTrace(trace: TraceRecord): void {
    this.dropped.traces += pushBounded(this.traceBuffer, [trace], this.limits.maxTraces);
  }

  /**
   * Flush all buffered data to the Sentrinel API.
   *
   * Never skipped: a flush requested while one is running is queued behind it
   * (one follow-up however many callers ask), where it used to return at once
   * — so a send hanging on a dead connection silently disabled every later
   * flush. Sends now time out, so a flush always finishes.
   */
  flush(): Promise<void> {
    if (this.inFlight) {
      if (!this.followUp) {
        this.followUp = this.inFlight
          .catch(() => {})
          .then(() => {
            this.followUp = null;
            return this.flush();
          });
      }
      return this.followUp;
    }
    const run = this.doFlush().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doFlush(): Promise<void> {
    try {
      const promises: Promise<void>[] = [];
      const base = {
        appName: this.options.appName,
        module: this.options.module,
        env: this.options.env || "dev",
      };

      // Exact limits before draining; the push path allows a little slack.
      this.dropped.requestLogs += trimTo(this.requestLogBuffer, this.limits.maxRequestLogs);
      this.dropped.appLogs += trimTo(this.appLogBuffer, this.limits.maxAppLogs);
      this.dropped.errors += trimTo(this.errorBuffer, this.limits.maxErrors);
      this.dropped.traces += trimTo(this.traceBuffer, this.limits.maxTraces);
      this.reportDrops();

      // Anything a previous flush could not deliver, first.
      promises.push(this.drainRetries(this.finalFlush));

      // Flush metrics
      if (this.endpointMetrics.size > 0) {
        const payload = this.buildMetricsPayload();
        this.endpointMetrics.clear();
        this.consumerMetrics.clear();
        const endpointChunks = chunk(payload.endpoints, MAX_ENDPOINTS_PER_BATCH);
        const consumerChunks = chunk(payload.consumers, MAX_CONSUMERS_PER_BATCH);
        const n = Math.max(endpointChunks.length, consumerChunks.length);
        for (let i = 0; i < n; i++) {
          const part: MetricsPayload = {
            ...payload,
            endpoints: endpointChunks[i] ?? [],
            consumers: consumerChunks[i] ?? [],
          };
          // Resource usage is one reading, not a sum — sent once per flush.
          if (i > 0) delete part.resourceUsage;
          promises.push(this.sendToServer("/api/ingest/metrics", part));
        }
      }

      // Flush request logs
      if (this.requestLogBuffer.length > 0) {
        const logs = this.requestLogBuffer.splice(0, this.requestLogBuffer.length);
        for (const part of chunk(logs, MAX_REQUESTS_PER_BATCH)) {
          const payload: RequestLogsPayload = { ...base, requests: part };
          promises.push(this.sendToServer("/api/ingest/requests", payload));
        }
      }

      // Flush application logs
      if (this.appLogBuffer.length > 0) {
        const logs = this.appLogBuffer.splice(0, this.appLogBuffer.length);
        for (const part of chunk(logs, MAX_LOGS_PER_BATCH)) {
          const payload: AppLogsPayload = { ...base, logs: part };
          promises.push(this.sendToServer("/api/ingest/logs", payload));
        }
      }

      // Flush errors
      if (this.errorBuffer.length > 0) {
        const errors = this.errorBuffer.splice(0, this.errorBuffer.length);
        for (const part of chunk(errors, MAX_ERRORS_PER_BATCH)) {
          const payload: ErrorPayload = { ...base, errors: part };
          promises.push(this.sendToServer("/api/ingest/errors", payload));
        }
      }

      // Traces, batched. They used to be posted one request per trace, and a
      // trace is recorded for every request — thousands of POSTs a flush for
      // a busy app, each one a slot in the retry queue during an outage.
      if (this.traceBuffer.length > 0) {
        const traces = this.traceBuffer.splice(0, this.traceBuffer.length);
        for (const part of chunkTraces(traces)) {
          const payload: TracesPayload = { ...base, traces: part };
          promises.push(this.sendToServer("/api/ingest/traces", payload));
        }
      }

      // Custom metrics ride the same flush. Drained here rather than buffered
      // per-record because the registry folds increments in memory — see
      // metrics.ts — so this is one row per series, not one per call.
      const points = metricRegistry().drain();
      if (points.length) {
        for (const part of chunk(points, MAX_CUSTOM_METRICS_PER_BATCH)) {
          promises.push(
            this.sendToServer("/api/ingest/custom-metrics", {
              ...base,
              version: this.options.version,
              metrics: part,
            })
          );
        }
      }

      await Promise.allSettled(promises);
    } catch (err) {
      this.log("Flush error:", err);
    }
  }

  /** One line per flush that had to drop something — never silent, never per record. */
  private reportDrops(): void {
    const d = this.dropped;
    const parts: string[] = [];
    if (d.requestLogs) parts.push(`${d.requestLogs} request logs`);
    if (d.appLogs) parts.push(`${d.appLogs} app logs`);
    if (d.errors) parts.push(`${d.errors} errors`);
    if (d.traces) parts.push(`${d.traces} traces`);
    if (d.consumers) parts.push(`${d.consumers} consumer rows`);
    if (!parts.length) return;
    console.warn(
      `[sentrinel] buffers were full since the last flush — dropped the oldest ${parts.join(", ")}. ` +
        `Lower requestLogging.sampleRate or flushInterval, or raise the buffer limits.`
    );
    this.dropped = { requestLogs: 0, appLogs: 0, errors: 0, traces: 0, consumers: 0 };
  }

  /** Build the metrics payload from the current buffer */
  private buildMetricsPayload(): MetricsPayload {
    // Calculate CPU usage since last flush
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const elapsedTime = currentTime - this.lastCpuTime;

    // Total CPU time in microseconds (user + system)
    const totalCpuMicros = currentCpuUsage.user + currentCpuUsage.system;

    // CPU % = (total_cpu_time / (elapsed_time * 1000)) * 100
    // Simplified: totalCpuMicros / (elapsedTime * 10)
    const cpuUsagePercent = elapsedTime > 0 ? totalCpuMicros / (elapsedTime * 10) : 0;

    // Reset for next flush
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
        // Exact, from the running totals — not from the sample.
        avgResponseTime: m.requestCount > 0 ? m.totalResponseTime / m.requestCount : 0,
        minResponseTime: m.requestCount > 0 ? m.minResponseTime : 0,
        maxResponseTime: m.requestCount > 0 ? m.maxResponseTime : 0,
        p50ResponseTime: len > 0 ? percentile(sorted, 0.5) : 0,
        p95ResponseTime: len > 0 ? percentile(sorted, 0.95) : 0,
        p99ResponseTime: len > 0 ? percentile(sorted, 0.99) : 0,
        totalRequestSize: m.totalRequestSize,
        totalResponseSize: m.totalResponseSize,
        statusCodes: m.statusCodes,
      };
    });

    // Cardinality guard.
    //
    // `identifier` is a dimension, and it must be stable for the same actor
    // across requests. Feed it a session id, a request id or a device id and
    // you get one consumer row per request — a table that grows without bound
    // and is joined on every Consumers query. It looks fine in staging and only
    // shows up under real traffic, so say something the first time the shape
    // looks wrong rather than waiting for someone to notice the row count.
    const distinctConsumers = new Set(
      Array.from(this.consumerMetrics.values()).map((c) => c.consumerIdentifier)
    ).size;
    const totalRequests = Array.from(this.endpointMetrics.values()).reduce(
      (sum, e) => sum + e.requestCount,
      0
    );
    if (totalRequests >= 50 && distinctConsumers > totalRequests * 0.8) {
      this.warnOnce(
        "consumer-cardinality",
        `${distinctConsumers} distinct consumers across ${totalRequests} requests — ` +
          "consumerIdentifier looks like it is returning something per-request " +
          "(a session or request id). It must be stable for the same user, or the " +
          "consumers table grows without bound."
      );
    }

    const consumers = Array.from(this.consumerMetrics.values()).map((c) => ({
      identifier: c.consumerIdentifier,
      // Only sent when the resolver supplied them; a bare string identifier
      // leaves both undefined and the server keeps whatever it already has.
      ...(c.consumerName ? { name: c.consumerName } : {}),
      ...(c.consumerGroup ? { group: c.consumerGroup } : {}),
      method: c.method,
      path: c.path,
      requestCount: c.requestCount,
      errorCount: c.errorCount,
      totalResponseTime: c.totalResponseTime,
    }));

    return {
      appName: this.options.appName,
      module: this.options.module,
      env: this.options.env || "dev",
      // Reported every flush; the server dedupes and only records changes.
      version: this.options.version,
      timestamp: new Date().toISOString(),
      endpoints,
      consumers,
      resourceUsage: {
        instanceId: INSTANCE_ID,
        cpuUsage: cpuUsagePercent,
        memoryRss: memUsage.rss,
        memoryHeapTotal: memUsage.heapTotal,
        memoryHeapUsed: memUsage.heapUsed,
      },
    };
  }

  private retryQueueFor(path: string): RetryQueue {
    let q = this.retries.get(path);
    if (!q) {
      q = new RetryQueue({
        maxQueued: this.options.retry?.maxQueued,
        maxQueuedBytes: this.options.retry?.maxQueuedBytes,
        maxAttempts: this.options.retry?.maxAttempts,
        baseDelayMs: this.options.retry?.baseDelayMs,
      });
      this.retries.set(path, q);
    }
    return q;
  }

  /**
   * Send a payload, holding it for another attempt if the failure looks
   * temporary. `attempts` is how many sends have already failed for this exact
   * payload — 0 for a fresh one, higher when the retry queue hands it back.
   */
  private async sendToServer(path: string, payload: any, attempts = 0): Promise<void> {
    const url = `${this.options.serverUrl}${path}`;
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      this.warnOnce(`serialize:${path}`, `could not serialize a ${path} batch — ${(err as Error)?.message}`);
      return;
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.options.apiKey) {
        headers["X-API-Key"] = this.options.apiKey;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: timeoutSignal(this.sendTimeoutMs),
      });

      if (res.status === 413) {
        // Still too big — a batch of unusually large rows can be over the
        // server's byte limit while under its row limit. Halve it and send both
        // halves; a single record that is still refused is dropped, loudly.
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
        // A rejected batch means telemetry is being dropped. Staying quiet
        // unless debug is on is how an app ends up sending nothing for days
        // while looking perfectly healthy — so misconfiguration is always
        // reported, once, with the server's own explanation.
        const text = await res.text().catch(() => "");
        const detail = text.slice(0, 300);
        if (res.status === 401 || res.status === 403) {
          this.warnOnce(
            `${path}`,
            `telemetry rejected (${res.status}). Check apiKey and env — ` +
              `the key must be issued for this environment. Server said: ${detail}`
          );
        } else if (res.status === 429) {
          this.warnOnce(`${path}`, `over quota (429) — telemetry is being dropped. ${detail}`);
        } else {
          this.warnOnce(`${path}`, `send failed: ${res.status} ${res.statusText}. ${detail}`);
        }
        // 4xx other than 408/429 is a payload or credential problem: it will
        // fail the same way forever, so it is dropped rather than queued.
        if (!this.finalFlush) this.retryQueueFor(path).enqueue(path, payload, res.status, attempts, body.length);
        return;
      }
      // Recovered — allow the next failure to be reported again.
      this.warned.delete(path);
      this.warned.delete(`connect:${path}`);
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      this.warnOnce(
        `connect:${path}`,
        timedOut
          ? `the Sentrinel server at ${url} did not answer within ${this.sendTimeoutMs}ms`
          : `cannot reach the Sentrinel server at ${url} — ${(err as Error)?.message ?? err}`
      );
      // Never reached the server (or never answered), which is the most
      // retryable failure there is: undefined status means "transport".
      if (!this.finalFlush) this.retryQueueFor(path).enqueue(path, payload, undefined, attempts, body.length);
    }
  }

  /**
   * Re-send whatever has come due, before this flush's own payloads.
   *
   * Order matters: retries first keeps the queue draining during a partial
   * outage instead of being permanently overtaken by fresh data. `all` takes
   * everything regardless of backoff — the last chance, at shutdown.
   */
  private async drainRetries(all = false): Promise<void> {
    const due = [...this.retries.values()].flatMap((q) => (all ? q.takeAll() : q.due()));
    if (due.length) {
      await Promise.allSettled(
        due.map((item) => this.sendToServer(item.path, item.body, item.attempts))
      );
    }

    let space = 0;
    let attempts = 0;
    for (const q of this.retries.values()) {
      const d = q.drainDropCounts();
      space += d.space;
      attempts += d.attempts;
    }
    if (space || attempts) {
      // Loud on purpose. Data was discarded; that should never be inferable
      // only from a gap in a chart.
      console.warn(
        `[sentrinel] dropped telemetry: ${space} over queue limit, ` +
          `${attempts} after exhausting retries`
      );
    }
  }

  /** How many payloads are waiting to be retried — surfaced for tests. */
  get pendingRetries(): number {
    let n = 0;
    for (const q of this.retries.values()) n += q.size;
    return n;
  }

  /**
   * Report a problem once per kind. A broken pipe flushes on every interval;
   * logging each failure would bury the app's own output.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[sentrinel] ${message}`);
  }

  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log("[sentrinel]", ...args);
    }
  }
}

/**
 * Halve a payload along its arrays. Null when there is nothing left to halve —
 * a single record the server still refuses.
 */
export function splitPayload(path: string, payload: any): any[] | null {
  const keys = SPLITTABLE[path];
  if (!keys || !payload || typeof payload !== "object") return null;
  const total = keys.reduce((n, k) => n + (Array.isArray(payload[k]) ? payload[k].length : 0), 0);
  if (total <= 1) return null;

  const first: any = { ...payload };
  const second: any = { ...payload };
  for (const key of keys) {
    const list: unknown[] = Array.isArray(payload[key]) ? payload[key] : [];
    const mid = Math.ceil(list.length / 2);
    first[key] = list.slice(0, mid);
    second[key] = list.slice(mid);
  }
  if ("resourceUsage" in second) delete second.resourceUsage;

  const nonEmpty = (p: any) => keys.some((k) => Array.isArray(p[k]) && p[k].length > 0);
  return [first, second].filter(nonEmpty);
}

// ─── Percentile calculation ─────────────────────────────────────────────────────

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}
