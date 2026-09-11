# Keys: which one, and what it can do

Every key is bound to **one integration and one app**. That is the whole design:
a key inside a phone, on a database host and in an agent's config each leak
differently, so each can only do its own job. Asking for the right kind is not
bureaucracy — the wrong kind fails with a `403` the SDK mentions once and then
never again.

They are issued in the dashboard: **API Keys → Generate → *What is this key
for?***

| Kind | Prefix | Can | Use it for |
|---|---|---|---|
| Server | `snt_live_`, `snt_dev_` | send application telemetry | a backend: Elysia, Express, Next.js, Bun, Django, a browser tunnel route |
| Mobile app | `snt_mobile_` | send what a phone sends | Flutter, iOS, Android — it ships inside a public bundle |
| Database collector | `snt_db_` | send Postgres statistics | the collector on the database host |
| OpenTelemetry | `snt_otlp_` | accept OTLP | an existing OTel exporter |
| AI agent — read only | `snt_mcp_` | read one app's issues, logs, traces, requests | the MCP server and CLI |
| AI agent — may resolve | `snt_mcprw_` | that, plus an issue's status | an agent you want to close issues |

Two properties worth knowing because they change what you should worry about:

- **Ingest keys cannot read.** A leaked server or mobile key cannot pull your
  issues or requests. Reading is only ever an agent key.
- **Agent keys cannot write telemetry.** A leaked agent key cannot poison your
  data, and its only write at all is an issue's status.

## Handling one

- It goes in the **environment**, or in a `0600` file the tool reads
  (`~/.sentrinel/env` for the agent tooling). Not in source, not in a config
  file you commit, not in an MCP server's JSON.
- **Never on a command line.** `ps` shows argv to every process on the machine,
  which is why neither the server nor the CLI takes a `--key` flag.
- **Never echo one back** — not into a message, a commit, a log, or a file you
  are writing. If you find one committed to a repository, say so plainly and
  tell the user to revoke it; revocation is immediate and you cannot do it for
  them.
- A key you are handed in conversation is still a credential. Put it in the
  environment or the env file, not into a snippet.

## What a wrong key looks like

| Symptom | Cause |
|---|---|
| `is a server (…) key` from the agent tooling | An ingest key where an AI agent key was needed. |
| `403` at SDK startup, then silence | Right kind, wrong `appName`/`env` for that key, or the wrong app. |
| `403` on `set_issue_status` only | Read-only agent key; a may-resolve key is a different issue kind. |
| `401` | Revoked or mistyped. |

→ <https://docs.sentrinel.dev/reference/mcp/> for the agent keys,
<https://docs.sentrinel.dev/reference/guide/> for the rest.
