# @sentrinel/plugin

Monitoring plugin for [Elysia.js](https://elysiajs.com) apps. Sends metrics, request logs, errors, application logs, and resource usage to a self-hosted [Sentrinel](https://github.com/Zaga-ltd/sentinel) server.

- **Exact metrics** — request counts, error rates, and response-time percentiles are aggregated in-process before sampling, so dashboards are always accurate.
- **Sampled request logs** — keep a fraction of successful requests; errors, slow requests, and requests that logged an error are always kept.
- **Application log capture** — console output during a request is captured (via AsyncLocalStorage) and correlated to that request in the dashboard.
- **Error tracking** — unhandled exceptions with stack traces.
- **Resource usage** — CPU and memory reported on every flush.
- **Header/body masking** — never ship secrets; mask by pattern.
- **Distributed tracing** — `traceSpan()`, `traced()`, `sentrinelFetch()` for W3C traceparent propagation.
- **Structured logging** — `getLogger()` with hierarchical categories, correlated attributes, and context inheritance.

## Install

```bash
bun add "@sentrinel/plugin@github:Zaga-ltd/sentinel_packages"
```

## Quick start

```ts
import { Elysia } from "elysia";
import { sentrinelPlugin } from "@sentrinel/plugin";

const app = new Elysia()
  .use(
    sentrinelPlugin({
      serverUrl: "http://localhost:3001",   // your Sentrinel API server
      appName: "my-api",
      env: "production",
      apiKey: process.env.SENTINEL_API_KEY, // per-app ingest key

      consumerIdentifier: (ctx) => ctx.request.headers.get("x-consumer"),

      requestLogging: {
        enabled: true,
        sampleRate: 0.25,              // keep 25% of fast successes
        slowRequestThresholdMs: 200,   // always keep slow requests
        logRequestHeaders: true,
        maskHeaders: [/^authorization$/i, /^cookie$/i],
      },

      logCapture: {
        enabled: true,                 // capture console.* per request
        minLevel: "info",
        maxPerRequest: 50,
      },
    })
  )
  .get("/", () => "hello")
  .listen(3000);
```

Requests that emit `console.error` are never sampled out, even when they return 200.

## Full configuration — collect everything

To enable every signal — request logs with payloads, console capture, structured
logging, distributed tracing, consumer tracking, deploy markers, and data
masking — use this complete configuration:

```ts
import { Elysia } from "elysia";
import { sentrinelPlugin } from "@sentrinel/plugin";

const app = new Elysia()
  .use(sentrinelPlugin({
    // Core
    serverUrl: "http://localhost:3001",
    appName: "my-api",
    env: "prod",
    apiKey: process.env.SENTRINEL_API_KEY,
    version: process.env.GIT_SHA,           // deploy markers on charts
    debug: false,
    flushInterval: 30000,

    // Consumer tracking
    consumerIdentifier: (ctx) =>
      ctx.request.headers.get("x-consumer-id") ?? "unknown",

    // Exclude health checks
    excludePaths: ["/health", "/metrics", /^\/internal\//],

    // Request logging — full request/response detail
    requestLogging: {
      enabled: true,
      sampleRate: 1.0,                      // keep 100% of fast successes
      slowRequestThresholdMs: 500,          // always capture slow requests
      logRequestHeaders: true,
      logRequestBody: true,
      logResponseBody: true,
      maxBodySize: 65536,                   // 64KB max body capture
      maskHeaders: [/^authorization$/i, /^cookie$/i, /^x-api-key$/i],
      maskQueryParams: ["token", "secret", "key"],
      maskBodyFields: [/^password$/i, /^token$/i, /^credit_card$/i, /^cvv$/i],
    },

    // Console log capture
    logCapture: {
      enabled: true,
      minLevel: "debug",                    // capture everything
      maxPerRequest: 100,
      maxMessageLength: 2000,
    },

    // Structured logging
    logging: {
      minLevel: "debug",
      echo: true,                           // mirror to stdout
    },
  }))
  .get("/", () => "hello")
  .listen(3000);
```

### Adding distributed tracing

```ts
import { traceSpan, traced, sentrinelFetch } from "@sentrinel/plugin";

// Manual span
const user = await traceSpan("db.findUser", async (span) => {
  span.setAttribute("db.system", "postgresql");
  return db.users.findById(id);
});

// Auto-trace a function
const getProducts = traced("db.getProducts", () => db.products.find());

// Cross-service calls propagate traceparent automatically
const res = await sentrinelFetch("https://payments.internal/v1/charges");
```

### Using the structured logger

```ts
import { getLogger, withContext, addRequestContext } from "@sentrinel/plugin";

const log = getLogger(["api", "checkout"]);

withContext({ userId: "u_123", tier: "enterprise" }, async () => {
  log.info("Payment authorized", { orderId: "o_456", amount: 99.99 });
  addRequestContext({ orderId: "o_456", cartTotal: 99.99 });
});
```

### Express adapter

```ts
import { sentrinelExpressMiddleware } from "@sentrinel/plugin/express";

app.use(sentrinelExpressMiddleware({
  serverUrl: "http://localhost:3001",
  appName: "my-express-api",
  env: "prod",
  apiKey: process.env.SENTRINEL_API_KEY,
  consumerIdentifier: "x-consumer-id",
  requestLogging: { enabled: true, sampleRate: 1.0, slowRequestThresholdMs: 500,
    logRequestHeaders: true, logRequestBody: true, logResponseBody: true },
  logCapture: { enabled: true, minLevel: "debug" },
  logging: { minLevel: "debug", echo: false },
}));
```

### Next.js adapter

```ts
import { sentrinelNextMiddleware } from "@sentrinel/plugin/next";

export const middleware = sentrinelNextMiddleware({
  serverUrl: process.env.SENTRINEL_URL!,
  appName: "my-next-app",
  env: process.env.VERCEL_ENV ?? "prod",
  apiKey: process.env.SENTRINEL_API_KEY,
  requestLogging: { enabled: true, sampleRate: 1.0, slowRequestThresholdMs: 500,
    logRequestHeaders: true, logRequestBody: true, logResponseBody: true },
  logCapture: { enabled: true, minLevel: "info" },
  logging: { minLevel: "debug", echo: false },
});
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `serverUrl` | — | Sentrinel API server base URL |
| `appName` | — | App name shown in the dashboard |
| `env` | `"dev"` | Environment label |
| `apiKey` | — | Ingest API key (required when the server enforces keys) |
| `flushInterval` | `30000` | Buffer flush interval in ms |
| `version` | — | Git SHA or semver; a change records a deploy marker |
| `consumerIdentifier` | — | Function or header name identifying the API client |
| `excludePaths` | `[]` | Paths to ignore (strings or regexes) |
| `requestLogging.enabled` | `false` | Enable request log rows |
| `requestLogging.sampleRate` | `1` | Fraction of successful requests to keep |
| `requestLogging.slowRequestThresholdMs` | `2000` | Always-capture threshold |
| `requestLogging.logRequestHeaders` | `false` | Include request headers |
| `requestLogging.logRequestBody` | `false` | Include request body |
| `requestLogging.logResponseBody` | `false` | Include response body |
| `requestLogging.maxBodySize` | `65536` | Max body bytes to capture |
| `requestLogging.maskHeaders` | `[]` | Headers to redact |
| `requestLogging.maskQueryParams` | `[]` | Query params to redact |
| `requestLogging.maskBodyFields` | `[]` | Body fields to redact (recursive) |
| `logCapture.enabled` | `false` | Capture console output per request |
| `logCapture.minLevel` | `"info"` | Minimum level to capture |
| `logCapture.maxPerRequest` | `50` | Per-request log cap |
| `logCapture.maxMessageLength` | `2000` | Truncate messages longer than this |
| `logging.minLevel` | `"debug"` | Drop records below this level |
| `logging.echo` | `false` | Mirror each record to stdout |

## Documentation

- **[FULL_CONFIG.md](../../docs/FULL_CONFIG.md)** — complete reference: every option, every signal, every dashboard page, backend and Flutter
- **[PLUGIN.md](../../docs/PLUGIN.md)** — plugin deep dive: sampling, masking, tracing, structured logging
- **[MOBILE.md](../../docs/MOBILE.md)** — Flutter/Dart SDK: crashes, release health, frames
- **[GUIDE.md](../../docs/GUIDE.md)** — what each dashboard page shows and needs

## License

MIT © Zaga Ltd
