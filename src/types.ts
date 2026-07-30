// ─── Sentrinel Plugin Types ──────────────────────────────────────────────────────

export interface SentrinelPluginOptions {
  /** URL of the Sentrinel API server (e.g., "http://localhost:3001") */
  serverUrl: string;

  /** Name of this application */
  appName: string;

  /** Environment (e.g., "dev", "staging", "prod") */
  env?: string;

  /** API key for authentication with the Sentrinel server */
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

  /**
   * Structured logging via getLogger(). Records are correlated to the active
   * request, trace and span automatically and shipped with the normal flush.
   */
  logging?: {
    /** Drop records below this level before they are buffered. */
    minLevel?: import("./logs").LogLevel;
    /**
     * Also print each record to stdout. Off by default — your app owns its
     * console output, and duplicating it surprises people in production.
     */
    echo?: boolean;
  };
  /**
   * App version (e.g. a git SHA or semver). Reported on every metrics flush;
   * a change is recorded as a deployment and annotated on every chart.
   */
  version?: string;

  /**
   * How to identify the API client behind a request: either a header name
   * (the framework adapters read it straight off the request) or a function
   * that derives one from the request context.
   */
  consumerIdentifier?: string | ((ctx: any) => string | null | undefined);

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
  /** Filled in from plugin options at flush time when the adapter omits it. */
  env?: string;
  consumerIdentifier?: string | null;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  queryParams?: Record<string, string>;
  errorMessage?: string;
  /** Links this request to a distributed trace; the API stores it on the row. */
  traceId?: string;
  /**
   * Business context attached via addRequestContext() — tier, customer id,
   * feature flags. Turns the request row into a canonical wide event.
   */
  attributes?: Record<string, unknown>;
  timestamp: string;
  /** Effective sampling rate this entry was captured at (1 = unsampled). */
  sampleRate?: number;
}

// ─── Payloads sent to Sentrinel API ──────────────────────────────────────────────

export interface MetricsPayload {
  appName: string;
  env: string;
  /** App version, when configured — drives deploy markers. */
  version?: string;
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
    /** Stable message; placeholders are NOT interpolated so it groups. */
    message: string;
    /** Dotted logger category, e.g. "api.checkout". */
    category?: string;
    /** Structured fields — what you actually filter and group by. */
    attributes?: Record<string, unknown>;
    requestId?: string;
    /** Correlates the line to a distributed trace… */
    traceId?: string;
    /** …and to the exact span that was running when it was written. */
    spanId?: string;
    /** Ordering within a request when timestamps collide. */
    seq?: number;
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
    /** The request this error came out of, so an issue can open it. */
    requestLogId?: string;
    /** …and its trace, so an issue can open the waterfall. */
    traceId?: string;
    /** Business context attached with addRequestContext(). */
    attributes?: Record<string, unknown>;
  }[];
}
