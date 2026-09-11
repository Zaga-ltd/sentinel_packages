# The CLI surface

For harnesses that do not speak MCP. Output is Markdown on stdout; every
failure goes to stderr with exit `1`, so a script can tell "no issues" from
"could not reach the API". `--json` on any command prints the raw API response
instead, for `jq`.

The key comes from `SENTRINEL_API_KEY` in the environment (the installer writes
`~/.sentrinel/env`). There is deliberately **no `--key` flag**: argv is visible
to every process on the machine. Never put a key on a command line, in a
committed config, or in a prompt.

## Errors

```bash
sentrinel issues                                  # unresolved, last 7 days
sentrinel issues --status all --period 24h --limit 50
sentrinel issues --sort users                     # widest blast radius
sentrinel issues --sort occurrences               # noisiest
sentrinel issues --search checkout
sentrinel issue <id> [--period 7d]                # → stack, request id, trace id
sentrinel request <id>                            # → the body that broke it
sentrinel trace <id>                              # → the span tree
sentrinel logs --level error --search "card declined" --period 2h
```

`--status` is `unresolved` (default), `resolved`, `ignored` or `all`.
`--sort` is `last_seen` (default), `occurrences`, `users` or `first_seen`.

## Databases

Periods here are **seconds**, not `7d` strings. Default `3600`.

```bash
sentrinel databases                               # → database ids
sentrinel queries <db-id> --sort total|mean|calls --period 3600
sentrinel activity <db-id> --period 3600
sentrinel dbhealth <db-id> --period 3600
```

## Writing

```bash
sentrinel resolve <id>      # needs an "AI agent — may resolve issues" key
sentrinel ignore <id>
sentrinel reopen <id>
```

## Composing

The output is designed to be piped into a prompt:

```bash
sentrinel issue 5f3ac1 | claude -p "Find the cause of this in the current repo and fix it."
sentrinel issues --sort users --json | jq -r '.issues[0].id'
sentrinel logs --level error --json | jq '.logs[] | {msg, requestId}'
```

A useful shape for a harness: take one id, pull its request, and hand both to
the model in the same prompt.

```bash
id=$(sentrinel issues --sort users --json | jq -r '.issues[0].id')
{ sentrinel issue "$id"; sentrinel request "$(sentrinel issue "$id" --json | jq -r '.latest.requestId')"; } \
  | your-agent -p "Fix this in the current repo. Add a test using the captured body."
```

## Exit codes

`0` with output, or `1` with a message on stderr. An empty list is `0` and a
line saying nothing matched — that is a real answer, not a failure, and usually
means the window was too short.
