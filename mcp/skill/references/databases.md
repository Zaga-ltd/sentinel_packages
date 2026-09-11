# Reading the database side

The Postgres collector reports from the database host, so these tools see what
the application's own telemetry cannot: how long a query really took, what it
waited on, and who was blocking it. Everything is scoped to the same app as the
rest of the key's access.

Start with `list_databases` (`sentrinel databases`) for the id. Periods are
**seconds**, default `3600`.

## `slow_queries` — where the time goes

Query *shapes*, not individual statements: `pg_stat_statements` normalises
parameters, so one row is every execution of that shape. Ranked by share of
total execution time by default.

- `sort: total` (default) — the shape that consumed the most database time. Fix
  this one first; it is usually a fast query run far too often, not a slow one.
- `sort: mean` — the slowest single execution. Often a report or a migration,
  and often fine.
- `sort: calls` — the most frequent. A cheap query at 50,000 calls a minute is
  an N+1 in disguise, and the fix is in the application, not the query.

Each row carries the full query text, call count, cache hit ratio and the
endpoints that called it — which is the link back to your code. A low cache hit
ratio on a hot shape means it is reading from disk: usually a missing index, or
a working set that no longer fits.

## `db_activity` — what it was waiting on

Use when queries are slow but no single shape looks expensive. That pattern is
almost always contention rather than cost.

- **Wait events** name the resource: `Lock` (another transaction), `LWLock`
  (internal contention), `IO` (disk), `Client` (the application is not reading
  the result).
- **Blocking chains** name the blocker and the blocked. Read the chain to its
  root; the leaf is a symptom.
- **Longest-running statements** catch the transaction someone left open.

## `db_health` — the four ways it stops

- **Connections** against the limit. Exhaustion looks like a total outage and is
  usually a pool misconfigured per-instance times instance count.
- **Idle in transaction** — a connection holding locks and blocking vacuum while
  doing nothing. Almost always application code that forgot to commit or to
  release, or a request that did I/O inside a transaction.
- **Commits vs rollbacks** — a rollback rate that climbs is errors, deadlocks,
  or a client timing out mid-transaction.
- **Deadlocks and temp bytes** — deadlocks are a lock-ordering bug in the
  application. Temp bytes mean sorts and hashes are spilling to disk: a query
  needs an index, or `work_mem` is too small for it.

## Turning a finding into a fix

The output names endpoints, not files. Search the repo for the route, then for
the query text or the ORM call that would produce that shape. State which one
you matched and how confident you are — the shape-to-code step is the one place
in this workflow where you are inferring rather than reading.

If the collector is not installed for this app, the database tools return
nothing. That is not an error to work around: say it, and point at
<https://docs.sentrinel.dev/reference/database/>.
