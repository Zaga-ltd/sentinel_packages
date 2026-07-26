import type {
  SentinelPluginOptions,
  EndpointMetrics,
  ConsumerRequestMetrics,
  RequestLogEntry,
  MetricsPayload,
  RequestLogsPayload,
  ErrorPayload,
  AppLogsPayload,
} from "./types";

// ─── Metrics Collector ──────────────────────────────────────────────────────────
// Buffers metrics in memory and flushes to the Sentinel API server periodically

export class MetricsCollector {
  private endpointMetrics: Map<string, EndpointMetrics> = new Map();
  private consumerMetrics: Map<string, ConsumerRequestMetrics> = new Map();
  private requestLogBuffer: RequestLogEntry[] = [];
  private appLogBuffer: AppLogsPayload["logs"] = [];
  private errorBuffer: ErrorPayload["errors"] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private options: SentinelPluginOptions;
  private isFlushing = false;
  
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: number;

  constructor(options: SentinelPluginOptions) {
    this.options = options;
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

  /** Flush all buffered data to the Sentinel API */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const promises: Promise<void>[] = [];

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

    const consumers = Array.from(this.consumerMetrics.values()).map((c) => ({
      identifier: c.consumerIdentifier,
      method: c.method,
      path: c.path,
      requestCount: c.requestCount,
      errorCount: c.errorCount,
      totalResponseTime: c.totalResponseTime,
    }));

    return {
      appName: this.options.appName,
      env: this.options.env || "dev",
      timestamp: new Date().toISOString(),
      endpoints,
      consumers,
      resourceUsage: {
        cpuUsage: cpuUsagePercent,
        memoryRss: memUsage.rss,
        memoryHeapTotal: memUsage.heapTotal,
        memoryHeapUsed: memUsage.heapUsed,
      }
    };
  }

  /** Send payload to the Sentinel API server */
  private async sendToServer(path: string, payload: any): Promise<void> {
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
        this.log(`Failed to send to ${path}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      this.log(`Failed to connect to Sentinel server at ${url}:`, err);
    }
  }

  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log("[sentinel]", ...args);
    }
  }
}

// ─── Percentile calculation ─────────────────────────────────────────────────────

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}
