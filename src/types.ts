// ─── Sentinel Plugin Types ──────────────────────────────────────────────────────

export interface SentinelPluginOptions {
  /** URL of the Sentinel API server (e.g., "http://localhost:3001") */
  serverUrl: string;

  /** Name of this application */
  appName: string;

  /** Environment (e.g., "dev", "staging", "prod") */
  env?: string;

  /** API key for authentication with the Sentinel server */
  apiKey?: string;

  /** Flush interval in milliseconds (default: 30000) */
  flushInterval?: number;

  /** Request logging configuration */
  requestLogging?: RequestLoggingOptions;

  /**
   * Capture console output emitted during request handling and correlate it
   * with the request log (shows up in the dashboard's Logs tab; requests with
   * error-level logs are never sampled out).
   */
  logCapture?: import("./logs").LogCaptureOptions;

  /** Function to extract consumer identifier from request context */
  consumerIdentifier?: (ctx: any) => string | null | undefined;

  /** Paths to exclude from monitoring (regex patterns) */
  excludePaths?: (string | RegExp)[];

  /** Enable debug logging */
  debug?: boolean;
}

export interface RequestLoggingOptions {
  /** Enable request logging (default: false) */
  enabled: boolean;

  /**
   * Fraction of successful requests to log, 0–1 (default: 1 = log all).
   *
   * Errors (status >= 400) and slow requests (see slowRequestThresholdMs)
   * are ALWAYS logged regardless of this rate. Aggregated metrics are
   * unaffected — counters are computed in-process before sampling, so
   * dashboards stay exact even at low sample rates. Logged rows carry
   * their effective sampleRate so counts can be extrapolated honestly.
   */
  sampleRate?: number;

  /**
   * Requests slower than this (ms) are always logged, regardless of
   * sampleRate. Defaults to the app's Apdex threshold semantics: 4× 500ms.
   */
  slowRequestThresholdMs?: number;

  /** Log request headers (default: false) */
  logRequestHeaders?: boolean;

  /** Log request body (default: false) */
  logRequestBody?: boolean;

  /** Log response body (default: false) */
  logResponseBody?: boolean;

  /** Max body size to log in bytes (default: 64KB) */
  maxBodySize?: number;

  /** Query parameters to mask (replaced with "***") */
  maskQueryParams?: (string | RegExp)[];

  /** Headers to mask */
  maskHeaders?: (string | RegExp)[];

  /** Body fields to mask (supports nested paths) */
  maskBodyFields?: (string | RegExp)[];
}

// ─── Internal metric types for buffer ───────────────────────────────────────────

export interface EndpointMetrics {
  method: string;
  path: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  responseTimes: number[];
  statusCodes: Record<string, number>;
  totalRequestSize: number;
  totalResponseSize: number;
}

export interface ConsumerRequestMetrics {
  consumerIdentifier: string;
  method: string;
  path: string;
  requestCount: number;
  errorCount: number;
  totalResponseTime: number;
}

export interface RequestLogEntry {
  /** Client-generated id so app logs can reference the request. */
  id?: string;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  requestSize: number;
  responseSize: number;
  env: string;
  consumerIdentifier?: string | null;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  queryParams?: Record<string, string>;
  errorMessage?: string;
  timestamp: string;
  /** Effective sampling rate this entry was captured at (1 = unsampled). */
  sampleRate?: number;
}

// ─── Payloads sent to Sentinel API ──────────────────────────────────────────────

export interface MetricsPayload {
  appName: string;
  env: string;
  timestamp: string;
  endpoints: {
    method: string;
    path: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    totalRequestSize: number;
    totalResponseSize: number;
    statusCodes: Record<string, number>;
  }[];
  consumers: {
    identifier: string;
    method: string;
    path: string;
    requestCount: number;
    errorCount: number;
    totalResponseTime: number;
  }[];
  resourceUsage?: {
    cpuUsage: number;
    memoryRss: number;
    memoryHeapTotal: number;
    memoryHeapUsed: number;
  };
}

export interface RequestLogsPayload {
  appName: string;
  env: string;
  requests: RequestLogEntry[];
}

export interface AppLogsPayload {
  appName: string;
  env: string;
  logs: Array<{
    timestamp: string;
    level: string;
    message: string;
    requestId?: string;
  }>;
}

export interface ErrorPayload {
  appName: string;
  env: string;
  errors: {
    method: string;
    path: string;
    statusCode: number;
    statusMessage: string;
    errorType?: string;
    errorMessage?: string;
    stackTrace?: string;
    consumerIdentifier?: string | null;
    timestamp: string;
  }[];
}
