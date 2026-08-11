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
  /**
   * Who is calling.
   *
   * A bare string names a header to read. A function may return either a
   * string, or a [ConsumerIdentity] when you also have a display name or a
   * segment to attach.
   */
  consumerIdentifier?:
    | string
    | ((ctx: any) => string | ConsumerIdentity | null | undefined);

  /**
   * What to do when a batch cannot be delivered.
   *
   * Failed payloads are held and re-sent with exponential backoff rather than
   * discarded. Only failures retrying can fix are kept — a 401 or a 422 is
   * dropped at once, because it would fail identically forever and would only
   * crowd out payloads that could still land.
   */
  retry?: {
    /** Payloads held at once; past this the oldest is dropped. Default 100. */
    maxQueued?: number;
    /** Attempts per payload before giving up. Default 5. */
    maxAttempts?: number;
    /** First backoff step in ms; doubles each attempt. Default 5000. */
    baseDelayMs?: number;
  };

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
  consumerName?: string;
  consumerGroup?: string;
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
  /** The URL as requested, ids and all — what you want to read on the row. */
  path: string;
  /**
   * The matched route pattern (`/orders/:id`), when the framework exposes one.
   *
   * `path` cannot serve both purposes: grouping by it makes one endpoint per
   * distinct id, which is an unbounded row count in the endpoints table and an
   * "active endpoints" figure in the hundreds for an app with thirty routes.
   * Consumers that group should prefer this and fall back to `path`.
   */
  route?: string;
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
  /**
   * The caller's address, resolved from proxy headers. Only this process can
   * still see it — by the time the payload reaches Sentrinel, the only address
   * left is the customer's own server.
   */
  clientIp?: string;
  /** ISO-3166 alpha-2 from the edge, when something upstream resolved one. */
  country?: string;
  /** The Host the client addressed. */
  host?: string;
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
    name?: string;
    group?: string;
    method: string;
    path: string;
    requestCount: number;
    errorCount: number;
    totalResponseTime: number;
  }[];
  resourceUsage?: {
    /** Which process reported this. See INSTANCE_ID in collector.ts. */
    instanceId?: string;
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

/**
 * A caller, identified.
 *
 * Three fields on purpose, and no more. `identifier` is what everything joins
 * on, so it must be **stable across requests for the same actor** — a session
 * id or a per-request uuid here creates one consumer row per request, and that
 * table is joined on every Consumers query.
 *
 * Contact details are deliberately absent. An identifier fans out into request
 * logs, span attributes, issue rows and exports; a phone number in that set is
 * a personal-data breach waiting to happen and answers no question the tool
 * exists to answer — you already hold the contact details in your own database,
 * keyed by exactly this id. Use `consumerUrl` to link there instead.
 */
export interface ConsumerIdentity {
  /** Stable, opaque key. A user id or tenant id — not an email or a phone. */
  identifier: string;
  /** Display label, so the UI reads as names rather than uuids. */
  name?: string;
  /** The segment to slice by: plan tier, tenant, region, app version. */
  group?: string;
}

/**
 * Normalise whatever a resolver returned into the three fields we store.
 *
 * Shared by every adapter so a `ConsumerIdentity` behaves identically on
 * Elysia, Bun and Express — the alternative is three near-copies that drift,
 * and an object silently stringifying to "[object Object]" on the two that
 * were not updated.
 */
export function resolveConsumer(
  value: string | ConsumerIdentity | null | undefined
): { identifier: string | null; name?: string; group?: string } {
  if (!value) return { identifier: null };
  if (typeof value === "string") return { identifier: value };
  return {
    identifier: value.identifier || null,
    name: value.name,
    group: value.group,
  };
}
