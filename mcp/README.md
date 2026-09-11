# @sentrinel/mcp

Sentrinel for coding agents: an MCP server (`src/server.ts`) and a CLI
(`src/cli.ts`) that hand an agent your issues, logs and traces.

Setup, the security model, and every tool: [docs/MCP.md](../../docs/MCP.md).

How it reaches users: `apps/web/build.ts` bundles `src/server.ts` and
`src/cli.ts` into single files and publishes them next to the marketing site
with `install.sh`, so the documented install is one line —
`curl -fsSL https://sentrinel.dev/install-mcp.sh | bash` — and needs neither a
clone nor a `bun install`. The same source is mirrored into the public package
repo (https://github.com/Zaga-ltd/sentinel_packages, under `mcp/`) by
`scripts/publish-plugin.sh`, for anyone who would rather read it or run it from
a checkout.

Note on dependencies: this package pins **zod 4**. The MCP SDK accepts zod 3.25
or 4, but with 3.25 its dual v3/v4 type trees push `tsc` past 4 GB on the
`registerTool` generics. Zod 4 type-checks the same code in about a second.

## The skill

`skill/` is the agent-facing documentation — how to use these tools well, not
what they are. `scripts/gen-skill.ts` generates `src/skill-content.ts` from it
so the bundle carries it, `sentrinel skill install [--cursor|--agents|--dir P]`
writes it wherever a harness reads from, and `tests/skill.test.ts` fails if the
generated copy drifts from the markdown. Edit the markdown, re-run the
generator, never edit the generated file.
