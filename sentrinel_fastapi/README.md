# Sentrinel for FastAPI

One middleware and every request, error, log line and trace of a FastAPI — or
any Starlette / ASGI — app reaches [Sentrinel](https://sentrinel.dev). No
runtime dependencies.

```bash
pip install "git+https://github.com/Zaga-ltd/sentinel_packages.git#subdirectory=sentrinel_fastapi"
```

```python
import os

from fastapi import FastAPI
from sentrinel_fastapi import SentrinelMiddleware

app = FastAPI()
app.add_middleware(
    SentrinelMiddleware,
    server_url="https://api.sentrinel.dev",
    app_name="orders",                          # the project
    module="api",                               # which part of it this service is
    env="prod",
    api_key=os.environ["SENTRINEL_API_KEY"],    # a Server key
)
```

That is the whole setup. Every option also reads from the environment
(`SENTRINEL_SERVER_URL`, `SENTRINEL_APP_NAME`, `SENTRINEL_API_KEY`, …), so a
container can be configured without code.

What arrives without configuring anything else:

- **Requests** — method, the URL, the FastAPI route it matched
  (`/orders/{order_id}` is reported as `/orders/:order_id`), status, timing,
  sizes, masked headers, client IP. Errors and slow requests always survive
  sampling.
- **Errors** — unhandled exceptions with their stack, and every 4xx/5xx
  response: an `HTTPException`'s `detail`, a validation failure as
  `query.limit: …`.
- **Traces** — an incoming `traceparent` is continued, so a tap in the phone
  app and the endpoint it reached are one waterfall. Add spans with
  `with span("db.query"):` or `@traced` (async functions included).
- **Metrics** — per-endpoint and per-consumer rollups, CPU and memory per
  worker.

Optional: `SentrinelLogHandler` for your log lines (each carries the request
that wrote it), `count` / `gauge` / `histogram` for your own numbers,
`async_httpx_transport()` to trace outgoing calls, and `sentrinel_tunnel` to
forward the browser SDK's batches without putting a key in the page.

Full reference: <https://docs.sentrinel.dev/reference/fastapi/>
