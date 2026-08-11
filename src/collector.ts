import type {
  SentrinelPluginOptions,
  EndpointMetrics,
  ConsumerRequestMetrics,
  RequestLogEntry,
  MetricsPayload,
  RequestLogsPayload,
  ErrorPayload,
  AppLogsPayload,
} from "./types";
import { RetryQueue } from "./retry";
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

// ─── Metrics Collector ──────────────────────────────────────────────────────────
// Buffers metrics in memory and flushes to the Sentrinel API server periodically

export class MetricsCollector {
  private endpointMetrics: Map<string, EndpointMetrics> = new Map();
  private consumerMetrics: Map<string, ConsumerRequestMetrics> = new Map();
  private requestLogBuffer: RequestLogEntry[] = [];
  private appLogBuffer: AppLogsPayload["logs"] = [];
  private errorBuffer: ErrorPayload["errors"] = [];
  private traceBuffer: any[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private options: SentrinelPluginOptions;
  private isFlushing = false;
  /** Problems already reported, so a broken pipe warns once, not every flush. */
  private warned = new Set<string>();
  /**
   * Payloads a failed send is holding on to.
   *
   * Without this a flush that fails loses its window outright — the buffers
   * are emptied before the post, so there is nothing left to try again with.
   */
  private retries: RetryQueue;
  
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: number;

  constructor(options: SentrinelPluginOptions) {
    this.options = options;
    // Built here, not as a field initializer: those run before the constructor
    // body, so `this.options` would still be undefined.
    this.retries = new RetryQueue({
      maxQueued: options.retry?.maxQueued,
      maxAttempts: options.retry?.maxAttempts,
      baseDelayMs: options.retry?.baseDelayMs,
    });
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }

  /** Start the periodic flush timer */
  start(): void {
    const interval = this.options.flushInterval || 30_000;
    this.flushTimer = setInterval(() => this.flush(), interval);
    this.log("Collector started, flushing every", interval, "ms");
  }

  /** Stop the collector and perform a final flush */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.log("Collector stopped");
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
    const key = `${data.method}:${data.path}`;
    const isError = data.statusCode >= 400;

    // Aggregate endpoint metrics
    let metrics = this.endpointMetrics.get(key);
    if (!metrics) {
      metrics = {
        method: data.method,
        path: data.path,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        responseTimes: [],
        statusCodes: {},
        totalRequestSize: 0,
        totalResponseSize: 0,
      };
      this.endpointMetrics.set(key, metrics);
    }

    metrics.requestCount++;
    if (isError) metrics.errorCount++;
    else metrics.successCount++;
    metrics.responseTimes.push(data.responseTime);
    metrics.totalRequestSize += data.requestSize;
    metrics.totalResponseSize += data.responseSize;

    const statusKey = String(data.statusCode);
    metrics.statusCodes[statusKey] = (metrics.statusCodes[statusKey] || 0) + 1;

    // Aggregate consumer metrics
    if (data.consumerIdentifier) {
      const consumerKey = `${data.consumerIdentifier}:${data.method}:${data.path}`;
      let cMetrics = this.consumerMetrics.get(consumerKey);
      if (!cMetrics) {
        cMetrics = {
          consumerIdentifier: data.consumerIdentifier,
          consumerName: data.consumerName,
          consumerGroup: data.consumerGroup,
          method: data.method,
          path: data.path,
          requestCount: 0,
          errorCount: 0,
          totalResponseTime: 0,
        };
        this.consumerMetrics.set(consumerKey, cMetrics);
      }
      cMetrics.requestCount++;
      if (isError) cMetrics.errorCount++;
      cMetrics.totalResponseTime += data.responseTime;
    }
  }

  /** Record an error */
  recordError(error: ErrorPayload["errors"][0]): void {
    this.errorBuffer.push(error);
  }

  /** Record a full request log entry */
  recordRequestLog(entry: RequestLogEntry): void {
    this.requestLogBuffer.push(entry);
  }

  /** Record application log lines captured during a request */
  recordAppLogs(logs: AppLogsPayload["logs"]): void {
    if (logs.length) this.appLogBuffer.push(...logs);
  }

  /** Record a completed trace (root span + any spans the handler recorded) */
  recordTrace(trace: any): void {
    this.traceBuffer.push(trace);
  }

  /** Flush all buffered data to the Sentrinel API */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const promises: Promise<void>[] = [];

      // Anything a previous flush could not deliver, first.
      promises.push(this.drainRetries());

      // Flush metrics
      if (this.endpointMetrics.size > 0) {
        const payload = this.buildMetricsPayload();
        this.endpointMetrics.clear();
        this.consumerMetrics.clear();
        promises.push(this.sendToServer("/api/ingest/metrics", payload));
      }

      // Flush request logs
      if (this.requestLogBuffer.length > 0) {
        const logs = [...this.requestLogBuffer];
        this.requestLogBuffer = [];
        const payload: RequestLogsPayload = {
          appName: this.options.appName,
          env: this.options.env || "dev",
          requests: logs,
        };
        promises.push(this.sendToServer("/api/ingest/requests", payload));
      }

      // Flush application logs
      if (this.appLogBuffer.length > 0) {
        const logs = this.appLogBuffer.splice(0, this.appLogBuffer.length);
        const payload: AppLogsPayload = {
          appName: this.options.appName,
          env: this.options.env || "dev",
          logs,
        };
        promises.push(this.sendToServer("/api/ingest/logs", payload));
      }

      // Flush errors
      if (this.errorBuffer.length > 0) {
        const errors = [...this.errorBuffer];
        this.errorBuffer = [];
        const payload: ErrorPayload = {
          appName: this.options.appName,
          env: this.options.env || "dev",
          errors,
        };
        promises.push(this.sendToServer("/api/ingest/errors", payload));
      }

      // Traces post one at a time — /api/traces accepts a single trace, and a
      // request rarely produces more than a handful per flush.
      if (this.traceBuffer.length > 0) {
        const traces = this.traceBuffer.splice(0, this.traceBuffer.length);
        for (const trace of traces) {
          promises.push(
            this.sendToServer("/api/ingest/traces", {
              appName: this.options.appName,
              env: this.options.env || "dev",
              ...trace,
            })
          );
        }
      }

      await Promise.allSettled(promises);
    } catch (err) {
      this.log("Flush error:", err);
    } finally {
      this.isFlushing = false;
    }
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
    let cpuUsagePercent = elapsedTime > 0 ? totalCpuMicros / (elapsedTime * 10) : 0;
    
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
        avgResponseTime: len > 0 ? sorted.reduce((a, b) => a + b, 0) / len : 0,
        minResponseTime: len > 0 ? sorted[0] : 0,
        maxResponseTime: len > 0 ? sorted[len - 1] : 0,
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
      }
    };
  }

  /**
   * Send a payload, holding it for another attempt if the failure looks
   * temporary. `attempts` is how many sends have already failed for this exact
   * payload — 0 for a fresh one, higher when the retry queue hands it back.
   */
  private async sendToServer(path: string, payload: any, attempts = 0): Promise<void> {
    const url = `${this.options.serverUrl}${path}`;
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
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // A rejected batch means telemetry is being dropped. Staying quiet
        // unless debug is on is how an app ends up sending nothing for days
        // while looking perfectly healthy — so misconfiguration is always
        // reported, once, with the server's own explanation.
        const body = await res.text().catch(() => "");
        const detail = body.slice(0, 300);
        if (res.status === 401 || res.status === 403) {
          this.warnOnce(
            `${path}`,
            `telemetry rejected (${res.status}). Check apiKey, appName and env — ` +
              `the key must belong to this app and environment. Server said: ${detail}`
          );
        } else if (res.status === 429) {
          this.warnOnce(`${path}`, `over quota (429) — telemetry is being dropped. ${detail}`);
        } else {
          this.warnOnce(`${path}`, `send failed: ${res.status} ${res.statusText}. ${detail}`);
        }
        // 4xx other than 429 is a payload or credential problem: it will fail
        // the same way forever, so it is dropped rather than queued.
        this.retries.enqueue(path, payload, res.status, attempts);
        return;
      }
      // Recovered — allow the next failure to be reported again.
      this.warned.delete(path);
    } catch (err) {
      this.warnOnce(
        `connect:${path}`,
        `cannot reach the Sentrinel server at ${url} — ${(err as Error)?.message ?? err}`
      );
      // Never reached the server at all, which is the most retryable failure
      // there is: undefined status means "transport", not "rejected".
      this.retries.enqueue(path, payload, undefined, attempts);
    }
  }

  /**
   * Re-send whatever has come due, before this flush's own payloads.
   *
   * Order matters: retries first keeps the queue draining during a partial
   * outage instead of being permanently overtaken by fresh data.
   */
  private async drainRetries(): Promise<void> {
    const due = this.retries.due();
    if (!due.length) return;

    await Promise.allSettled(
      due.map((item) => this.sendToServer(item.path, item.body, item.attempts))
    );

    const dropped = this.retries.drainDropCounts();
    if (dropped.space || dropped.attempts) {
      // Loud on purpose. Data was discarded; that should never be inferable
      // only from a gap in a chart.
      console.warn(
        `[sentrinel] dropped telemetry: ${dropped.space} over queue limit, ` +
          `${dropped.attempts} after exhausting retries`
      );
    }
  }

  /** How many payloads are waiting to be retried — surfaced for tests. */
  get pendingRetries(): number {
    return this.retries.size;
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

// ─── Percentile calculation ─────────────────────────────────────────────────────

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}
