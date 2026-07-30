# @sentrinel/plugin

Monitoring plugin for [Elysia.js](https://elysiajs.com) apps. Sends metrics, request logs, errors, application logs, and resource usage to a self-hosted [Sentrinel](https://github.com/Zaga-ltd/sentinel) server.

- **Exact metrics** — request counts, error rates, and response-time percentiles are aggregated in-process before sampling, so dashboards are always accurate.
- **Sampled request logs** — keep a fraction of successful requests; errors, slow requests, and requests that logged an error are always kept.
- **Application log capture** — console output during a request is captured (via AsyncLocalStorage) and correlated to that request in the dashboard.
- **Error tracking** — unhandled exceptions with stack traces.
- **Resource usage** — CPU and memory reported on every flush.
- **Header/body masking** — never ship secrets; mask by pattern.

## Install

```bash
bun add "@sentrinel/plugin@github:Zaga-ltd/sentinel_packages"
```

## Usage

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

## Options

| Option | Default | Description |
| --- | --- | --- |
| `serverUrl` | — | Sentrinel API server base URL |
| `appName` | — | App name shown in the dashboard |
| `env` | `"dev"` | Environment label |
| `apiKey` | — | Ingest API key (required when the server enforces keys) |
| `flushInterval` | `30000` | Buffer flush interval in ms |
| `consumerIdentifier` | — | Function extracting a client/consumer id from the request |
| `requestLogging.sampleRate` | `1` | Fraction of successful requests to keep |
| `requestLogging.slowRequestThresholdMs` | — | Requests at/above this are always kept |
| `logCapture.enabled` | `false` | Capture console output per request |
| `logCapture.minLevel` | `"info"` | Minimum level to capture |
| `logCapture.maxPerRequest` | `50` | Per-request log cap |

## License

MIT © Zaga Ltd
