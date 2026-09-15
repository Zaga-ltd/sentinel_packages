# FieldOps — one project, every part, one trace

A complete field-service product, instrumented top to bottom, built to exercise
**every** Sentrinel feature at once — and to show the idea Sentrinel is built
around: **an app is the project**. The backend, the technician's phone, the
dispatcher's browser, the database and a coding agent all report into **one**
Sentrinel app as modules of it, so a tap on the phone can be followed into the
request it made, the handler that served it and the work that handler did.

| Part | Module | What it is |
|---|---|---|
| [`backend/`](backend) | `backend` | Elysia API — **52 routes**, full CRUD across 8 domains, `@sentrinel/plugin` |
| [`mobile/`](mobile) | `mobile` | Flutter technician app — `sentrinel` + `sentrinel_flutter` |
| [`web/`](web) | `web` | Dispatcher console in the browser — `@sentrinel/plugin/browser` behind a tunnel |
| [`docker-compose.yml`](docker-compose.yml) | `postgres` | A Postgres with `pg_stat_statements`, watched by the Sentrinel collector |
| your coding agent | `agent` | The Sentrinel MCP server, reading this project's issues, logs and traces |
| [`simulate.ts`](simulate.ts) | — | Traffic generator — 36 weighted scenarios, 13 consumers |

## How the parts fit together

```
 phone   (mobile) ──traceparent──▶ backend ──▶ db · billing · notify spans
 browser (web)    ──traceparent──▶ backend
 postgres ◀── collector (postgres)            agent (MCP) ── reads ──▶ the same app
```

Each part has its own API key, all issued for the one app, and each key is bound
to what its part may do: a *Mobile app* key can only send what a phone sends, a
*Database collector* key only Postgres statistics, an *AI agent* key only reads.
A part is named by its key unless its SDK sets `module` — the three here do.

In the dashboard, **API Keys → Parts of this project** lists every part and when
it last reported. Request rows carry the module. A trace that crosses parts —
a tap on the phone, a click in the console — labels every span with the part it
ran in, and the phone's or browser's `CLIENT` span is its root.

---

## Run it

You need a Sentrinel to report to. In the monorepo, run these from the repository
root. From the public [`sentinel_packages`](https://github.com/Zaga-ltd/sentinel_packages)
repo, run `bun install` in `examples/fieldops` first and use `bun run backend`,
`bun run web` and `bun run simulate` with the same variables.

**1 — one app, a key per part** (once)

In the dashboard create an app named `fieldops`, then in **API Keys** generate:

| Key name | Kind | Used by |
|---|---|---|
| `backend` | Server | the backend |
| `web` | Server | the web console's tunnel — the key stays on the server |
| `mobile` | Mobile app | the Flutter app |
| `postgres` | Database collector | the collector |
| `agent` | AI agent — read only | the MCP server |

**2 — the backend**

```bash
SENTRINEL_URL=http://localhost:3001 SENTRINEL_KEY=<backend key> \
  bun run examples/fieldops/backend/server.ts        # :4400
```

**3 — the web console**

```bash
SENTRINEL_URL=http://localhost:3001 SENTRINEL_KEY=<web key> FIELDOPS_API=http://localhost:4400 \
  bun run examples/fieldops/web/server.ts            # open http://localhost:4500
```

Complete a job, then open that request's trace: the browser's `CLIENT` span is
the root, and the backend's handler with its db, billing and notify spans hangs
off it.

**4 — the traffic**

```bash
FIELDOPS_API=http://localhost:4400 bun run examples/fieldops/simulate.ts --duration 120 --rps 22
```

**5 — the phone**

```bash
cd examples/fieldops/mobile && flutter run \
  --dart-define=SENTRINEL_KEY=<mobile key> \
  --dart-define=SENTRINEL_URL=http://localhost:3001 \
  --dart-define=FIELDOPS_API=http://localhost:4400
```

The iOS simulator reaches `localhost` directly; on an **Android emulator** use
`http://10.0.2.2:<port>`. Open a job and tap **Complete** — one trace from the tap
to the invoice.

**6 — the database**

```bash
docker compose -f examples/fieldops/docker-compose.yml up -d    # Postgres on :5433
```

Then run the collector against it with the `postgres` key:

```bash
DATABASE_URL=postgres://fieldops:fieldops@localhost:5433/fieldops \
SENTRINEL_URL=http://localhost:3001 SENTRINEL_KEY=<postgres key> SENTRINEL_INSTANCE=fieldops-db \
  bun run packages/pg-collector/src/cli.ts      # in the monorepo
```

Outside the monorepo, install it with
`curl -fsSL https://sentrinel.dev/install-collector.sh | sudo bash` and give
`sentrinel-collector config set` the same four values. The instance appears under
**Databases** for the `fieldops` app, because the key it reports with belongs to
that app.

**7 — the agent**

```bash
curl -fsSL https://sentrinel.dev/install-mcp.sh | SENTRINEL_API_KEY=<agent key> bash
```

Then ask it about FieldOps — *what is failing in fieldops right now?*, *show me the
trace for the last failed job completion*. It reads the same app every other part
writes to.

---

## What each dashboard page gets

| Page | Where the data comes from |
|---|---|
| **Overview / Traffic** | 52 routes, ~22 req/s, weighted so reads dominate |
| **Errors** | a steady floor of 401 / 404 / 409 / 422 / 500 / 503 |
| **Issues** | four distinct exception classes from `/ops/boom`, plus `InsufficientStock` from real domain rules, plus the console's page errors |
| **Performance** | `/analytics/*` scans everything; `/ops/slow` parks for seconds |
| **Consumers** | 10 technicians + dispatch console, billing cron, partner integration |
| **Logs** | four levels under `fieldops.*` categories; `/ops/logstorm` floods on demand |
| **Traces** | `POST /workorders/:id/complete` nests db → billing → outbound notify, under the phone's or the browser's span |
| **Requests** | fat photo uploads, masked auth bodies, each row labelled `backend`, `mobile` or `web` |
| **API Keys** | every part of the project, and when it last reported |
| **Databases** | the collector's instance, linked to the `fieldops` app |
| **Sessions / Release health** | the Flutter app (release `2.4.0+24`) and the console (`fieldops-web@2.4.0`) |
| **Crashes** | Diagnostics tab: non-fatal, fatal, uncaught async, framework, isolate |

---

## The failure levers

Everything fails on purpose somewhere, but these are the direct switches:

```bash
curl "localhost:4400/api/v1/ops/slow?ms=3000"      # slow request
curl "localhost:4400/api/v1/ops/flaky?rate=0.8"    # 503s
curl "localhost:4400/api/v1/ops/boom?kind=2"       # 500, four error classes
curl -X POST localhost:4400/api/v1/ops/logstorm -H 'content-type: application/json' -d '{"count":100}'
```

In the app, the **Diagnostics** tab has one button per telemetry type, and
**Parts → 100k** reserves more stock than exists to produce a grouped issue.

---

## Four defects this demo found, and their fixes

Running it against a clean install surfaced four real bugs in Sentrinel. All
four are fixed; the numbers are from identical traffic before and after.

| | Before | After |
|---|---|---|
| POST bodies captured | 0 of 44 | **47 of 52** |
| `endpoints` rows for 34 routes | 493 | **34** |
| Overview "active endpoints" | 447 | **34** |
| Global percentiles | p95 = p99 = 60.9ms | **p50 23.3 · p95 149.7 · p99 719.8** |
| Isolate crash reported | never | **yes** |

**1. `requestBody` was never captured for Elysia apps.** The payload was read in
the `derive` hook, which runs *after* Elysia parses the body — the clone came
back drained. Capture moved to `onRequest`, before anything can consume the
stream. The old test only asserted the *handler* could still read its body, so
it passed throughout; `packages/plugin/tests/request-payload.test.ts` now
asserts the telemetry actually carries it.

**2. The `endpoints` table grew without bound.** Request logs report the real
URL — you want that on the row — but ingest registered an endpoint from it, so
every id minted a permanent row. `RequestLogEntry` now carries `route`
alongside `path`, and ingest groups on the route while the row keeps the URL.
Covered by `apps/api/tests/endpoint-cardinality.test.ts`.

**3. Global p95/p99 averaged pre-aggregated percentiles.** `AVG(p95_response_time)`
across rollup rows answers "what is the typical endpoint's p95", not "what is
this service's p95". The two coming back *identical* was the tell. There is now
a `latencyPercentiles` method on the LogStore computing real quantiles over raw
logs, implemented for both ClickHouse and Postgres.

**4. Isolate errors never arrived.** `Isolate.current.addErrorListener` covers
only the current isolate, and `Isolate.spawn` does not inherit the spawner's
error ports — a worker died to stderr and reported nothing. `isolateErrorPort`
exposes the port to pass as `onError`:

```dart
await Isolate.spawn(work, message, onError: isolateErrorPort);
```

It is a top-level getter rather than a `Sentrinel` member so it can be typed
`SendPort?` without `sentrinel.dart` importing `dart:isolate`, which would break
the web build. Typing it `dynamic` instead compiled and ran, but handed an
analyzer error to every caller with strict-casts enabled.

### Verified working, end to end

Mobile → backend **trace continuation** is real: every request the app made
shared a trace id with the backend request it caused. Crash persistence works as
designed — a fatal is spooled to disk and delivered on the *next* launch, which
is why it appears only after a restart.
