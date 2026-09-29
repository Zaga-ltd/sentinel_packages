export interface SentrinelPluginOptions {
    /** URL of the Sentrinel API server (e.g., "http://localhost:3001") */
    serverUrl: string;
    /** Name of this application */
    appName: string;
    /** Environment (e.g., "dev", "staging", "prod") */
    env?: string;
    /** API key for authentication with the Sentrinel server */
    apiKey?: string;
    /**
     * Which part of your project this is — "backend", "worker", "auth-service".
     *
     * An app in Sentrinel is the whole project: your backend, your mobile app and
     * your web client are one app, so a request can be followed from the phone to
     * the query it ended in. This names the part.
     *
     * Optional. Without it the part is taken from the API key's name, which is
     * what you want when each part has its own key. Set it when several services
     * share one key, so they can still be told apart.
     */
    module?: string;
    /** Flush interval in milliseconds (default: 30000) */
    flushInterval?: number;
    /** Request logging configuration */
    requestLogging?: RequestLoggingOptions;
    /**
     * Capture console output emitted during request handling and correlate it
     * with the request log (shows up in the dashboard's Logs tab; requests with
     * error-level logs are never sampled out).
     */
    logCapture?: import("./logs.js").LogCaptureOptions;
    /**
     * Structured logging via getLogger(). Records are correlated to the active
     * request, trace and span automatically and shipped with the normal flush.
     */
    logging?: {
        /** Drop records below this level before they are buffered. */
        minLevel?: import("./logs.js").LogLevel;
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
    consumerIdentifier?: string | ((ctx: any) => string | ConsumerIdentity | null | undefined);
    /**
     * Which `x-sentrinel-consumer` values to trust when `consumerIdentifier`
     * resolves nothing.
     *
     * The browser SDK sends that header on same-origin calls — `guest:<device>`
     * for a signed-out visitor, the identified user otherwise. `guest:` values
     * are always accepted: they name a device, not a person, so claiming one
     * impersonates nobody. Anything else is a claim a page makes about itself,
     * and is accepted only when it matches this pattern. Leave it unset unless
     * the values it admits are harmless to spoof.
     */
    consumerHeaderPattern?: RegExp;
    /**
     * What to do when a batch cannot be delivered.
     *
     * Failed payloads are held and re-sent with exponential backoff rather than
     * discarded. Only failures retrying can fix are kept — a 401 or a 422 is
     * dropped at once, because it would fail identically forever and would only
     * crowd out payloads that could still land. Each payload type has its own
     * queue, so an outage full of request logs cannot evict metrics.
     */
    retry?: {
        /** Payloads held at once, per payload type; past this the oldest is dropped. Default 100. */
        maxQueued?: number;
        /** Serialized bytes held at once, per payload type. Default 8MB. */
        maxQueuedBytes?: number;
        /** Attempts per payload before giving up. Default 5. */
        maxAttempts?: number;
        /** First backoff step in ms; doubles each attempt. Default 5000. */
        baseDelayMs?: number;
    };
    /**
     * How long one POST to Sentrinel may take before it is abandoned (and
     * retried). Default 10000. Without a limit a hung connection held its batch
     * — and every later flush — indefinitely.
     */
    sendTimeoutMs?: number;
    /**
     * Records held between flushes, per type. Past a limit the oldest are
     * dropped and the count is reported once per flush. Metrics are aggregated
     * rather than buffered, so they are exact whatever these are.
     */
    buffer?: {
        /** Default 10000. */
        maxRequestLogs?: number;
        /** Default 10000. */
        maxAppLogs?: number;
        /** Default 5000. */
        maxErrors?: number;
        /** Default 5000. */
        maxTraces?: number;
    };
    /**
     * Process-level hooks, on by default (off when `NODE_ENV` is `test`).
     *
     * - `flushOnExit`: on SIGTERM, SIGINT and `beforeExit`, flush what is
     *   buffered — waiting at most `timeoutMs` — before the process goes. The
     *   signal's default behaviour (exiting) is preserved when nothing else
     *   handles it.
     * - `captureErrors`: report `uncaughtException` and `unhandledRejection`,
     *   flush, then behave as Node would have without the hook (print and exit
     *   with code 1), unless your app has its own handlers, which then decide.
     *
     * `false` turns both off.
     */
    processHooks?: boolean | {
        flushOnExit?: boolean;
        captureErrors?: boolean;
        /** Longest wait for the final flush, in ms. Default 3000. */
        timeoutMs?: number;
    };
    /** Paths to exclude from monitoring (regex patterns) */
    excludePaths?: (string | RegExp)[];
    /**
     * Skip a request entirely, decided from the request itself.
     *
     * `excludePaths` covers what a path can express — health checks, static
     * files. This covers what it cannot: a server that monitors itself must not
     * record the reports it posts to itself, and those are told apart by the key
     * they carry, not by their route. Recording them makes each report produce
     * another, and the count grows on every flush.
     */
    excludeRequest?: (request: Request) => boolean;
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
    /**
     * Max body size to log in bytes (default: 64KB). Bodies are read only up to
     * this — the rest of the stream is never buffered for logging.
     */
    maxBodySize?: number;
    /**
     * Extra query parameters to mask (replaced with "***"). Added to a built-in
     * list that always applies: token, key, api_key, code, password, signature,
     * access_token and anything ending in `token`/`signature` or containing
     * `secret`/`password`/`credential`.
     */
    maskQueryParams?: (string | RegExp)[];
    /**
     * Extra headers to mask. Added to a built-in list that always applies:
     * authorization, proxy-authorization, cookie, set-cookie, x-api-key,
     * x-auth-token and anything ending in `token` or containing `secret`,
     * `password` or `api-key`.
     */
    maskHeaders?: (string | RegExp)[];
    /**
     * Extra body fields to mask, at any depth, in JSON, form-encoded and
     * multipart bodies. Added to a built-in list that always applies: password,
     * passwd, secret, token (and `*_token`/`*Token`), api_key/apikey,
     * authorization, credit card number fields, cvv/cvc, pin, ssn.
     */
    maskBodyFields?: (string | RegExp)[];
}
export interface EndpointMetrics {
    method: string;
    path: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    /**
     * A bounded reservoir sample, for percentiles. Count, sum, min and max are
     * kept exactly alongside it, so only the percentiles are estimates — and
     * only once an endpoint has served more requests in a window than the
     * reservoir holds.
     */
    responseTimes: number[];
    totalResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
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
export interface MetricsPayload {
    appName: string;
    /** Which part of the project sent this. Defaults to the key's name. */
    module?: string;
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
    /** Which part of the project sent this. Defaults to the key's name. */
    module?: string;
    env: string;
    requests: RequestLogEntry[];
}
export interface AppLogsPayload {
    appName: string;
    /** Which part of the project sent this. Defaults to the key's name. */
    module?: string;
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
        /**
         * Who the request belonged to, stamped by the plugin from the same
         * `consumerIdentifier` the request row uses — so a user's log lines are
         * findable without joining through a request that may have expired.
         */
        consumerIdentifier?: string | null;
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
    /** Which part of the project sent this. Defaults to the key's name. */
    module?: string;
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
/** One trace as it travels in a `POST /api/ingest/traces` batch. */
export interface TraceRecord {
    traceId: string;
    requestLogId?: string;
    name: string;
    startTime: string;
    endTime?: string;
    durationMs: number;
    statusCode?: number | string;
    spans: object[];
}
export interface TracesPayload {
    appName: string;
    module?: string;
    env: string;
    traces: TraceRecord[];
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
export declare function resolveConsumer(value: string | ConsumerIdentity | null | undefined): {
    identifier: string | null;
    name?: string;
    group?: string;
};
