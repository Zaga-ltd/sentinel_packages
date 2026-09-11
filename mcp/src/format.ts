// ─── Markdown for agents ─────────────────────────────────────────────────────
//
// An agent reads text, and the text it reads shapes what it does next. So each
// renderer ends with the identifiers the agent needs for its *next* call —
// an issue lists its request and trace ids — rather than leaving it to guess
// which field to pass where.
//
// Everything is defensive about shape. These render API responses, and an API
// field renamed on the other side must degrade to a missing line, not a crash
// that hides the whole issue from the agent.

type Any = Record<string, any>;

export function ago(iso?: string | null): string {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return String(iso);
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const short = (id?: string | null) => (id ? String(id).slice(0, 8) : "—");
const fence = (s: string, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "` ` `") + "\n```";
const clip = (s: unknown, n = 4000) => {
  const t = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  return t.length > n ? t.slice(0, n) + `\n… (${t.length - n} more chars)` : t;
};

// ── Issues ──────────────────────────────────────────────────────────────────

const SORT_LABEL: Record<string, string> = {
  occurrences: "most repeated first",
  users: "most users affected first",
  first_seen: "oldest first",
  last_seen: "newest firing first",
};

export function issuesToMarkdown(
  res: { issues?: Any[]; counts?: Any },
  status = "unresolved",
  sort?: string
): string {
  const issues = res.issues ?? [];
  const label = status && status !== "all" ? `${status} issues` : "issues";
  if (!issues.length) return `No ${label} in this window.`;

  const ranked = SORT_LABEL[sort ?? "last_seen"] ?? "newest firing first";
  const lines = [`## ${issues.length} ${label} — ${ranked}`, ""];
  issues.forEach((i, n) => {
    const where = i.culprit ? ` — \`${i.culprit}\`` : "";
    lines.push(`${n + 1}. **${i.title ?? i.errorType ?? "Untitled"}**${where}`);
    const bits = [
      `id: ${i.id}`,
      i.occurrences != null ? `${i.occurrences} occurrences` : null,
      i.consumersAffected != null ? `${i.consumersAffected} users` : null,
      `last ${ago(i.lastSeenAt)}`,
      i.statusCode ? `HTTP ${i.statusCode}` : null,
      i.sampleRequestPath ? `\`${i.sampleRequestPath}\`` : null,
      i.regressedAt ? "**regressed**" : null,
    ].filter(Boolean);
    lines.push(`   ${bits.join(" · ")}`);
  });
  if (res.counts) {
    const c = res.counts;
    lines.push("", `_${c.unresolved ?? 0} unresolved · ${c.resolved ?? 0} resolved · ${c.ignored ?? 0} ignored_`);
  }
  lines.push(
    "",
    "Next: `get_issue <id>` for the stack trace and the request that caused it.",
    "Ask a different question with `sort`: occurrences (noisiest), users (widest impact), first_seen (longest broken)."
  );
  return lines.join("\n");
}

export function issueToMarkdown(res: Any): string {
  const i = res.issue ?? res;
  const lines: string[] = [];

  lines.push(`# ${i.title ?? i.errorType ?? "Issue"}`);
  if (i.culprit) lines.push(`in \`${i.culprit}\``);
  lines.push("");
  lines.push(
    [
      `**${i.status ?? "unknown"}**`,
      i.level ? `level ${i.level}` : null,
      i.occurrences != null ? `${i.occurrences} occurrences` : null,
      res.stats?.consumersAffected != null ? `${res.stats.consumersAffected} users affected` : null,
      `first ${ago(i.firstSeenAt)}`,
      `last ${ago(i.lastSeenAt)}`,
      i.regressedAt ? `**regressed ${ago(i.regressedAt)}**` : null,
      i.statusCode ? `HTTP ${i.statusCode}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
  );
  lines.push(`id: \`${i.id}\``);

  if (i.sampleMessage && i.sampleMessage !== i.title) lines.push("", "## Message", "", clip(i.sampleMessage, 1500));

  const stack = res.recent?.[0]?.stackTrace ?? i.sampleStackTrace;
  if (stack) lines.push("", "## Stack trace", "", fence(clip(stack, 6000)));

  const endpoints: Any[] = res.endpoints ?? [];
  if (endpoints.length) {
    lines.push("", "## Where it fires", "");
    for (const e of endpoints.slice(0, 10)) {
      const name = e.method && e.path ? `${e.method} ${e.path}` : e.path ?? e.endpoint ?? e.name ?? JSON.stringify(e);
      lines.push(`- \`${name}\` — ${e.count ?? "?"}×`);
    }
  }

  const recent: Any[] = res.recent ?? [];
  if (recent.length) {
    lines.push("", "## Recent occurrences", "");
    for (const r of recent.slice(0, 5)) {
      const bits = [
        r.timestamp ? ago(r.timestamp) : null,
        r.requestPath ? `\`${r.requestPath}\`` : null,
        r.requestLogId ? `request \`${r.requestLogId}\`` : null,
        r.traceId ? `trace \`${r.traceId}\`` : null,
        r.consumerIdentifier ? `user ${r.consumerIdentifier}` : null,
      ].filter(Boolean);
      lines.push(`- ${bits.join(" · ")}`);
    }
    const first = recent[0];
    if (first?.attributes && Object.keys(first.attributes).length) {
      lines.push("", "Attributes on the latest occurrence:", "", fence(clip(first.attributes, 2000), "json"));
    }
  }

  const consumers: Any[] = res.consumers ?? [];
  if (consumers.length) {
    lines.push("", "## Users hit", "");
    for (const c of consumers.slice(0, 8)) {
      lines.push(`- ${c.consumerIdentifier ?? c.identifier ?? c.consumerId ?? "anonymous"} — ${c.count ?? "?"}×`);
    }
  }

  const next: string[] = [];
  const r0 = recent[0];
  if (r0?.requestLogId) next.push(`\`get_request ${r0.requestLogId}\` — the exact request, body and response`);
  if (r0?.traceId) next.push(`\`get_trace ${r0.traceId}\` — every span on the way to the failure`);
  next.push(`\`search_logs\` with the culprit or message for the lines around it`);
  next.push(`\`set_issue_status ${i.id} resolved\` once the fix has shipped (needs a may-resolve agent key)`);
  lines.push("", "## Next", "", ...next.map((n) => `- ${n}`));

  return lines.join("\n");
}

// ── Logs ────────────────────────────────────────────────────────────────────

export function logsToMarkdown(res: { logs?: Any[]; pagination?: Any }): string {
  const logs = res.logs ?? [];
  if (!logs.length) return "No log lines matched.";
  const lines = [`## ${logs.length} log lines${res.pagination?.total ? ` (of ${res.pagination.total})` : ""}`, ""];
  for (const l of logs) {
    const when = l.timestamp ? new Date(l.timestamp).toISOString() : "";
    const level = String(l.level ?? "info").toUpperCase().padEnd(5);
    const ctx = [
      l.requestId ? `req ${short(l.requestId)}` : null,
      l.traceId ? `trace ${short(l.traceId)}` : null,
      l.consumerIdentifier ? `user ${l.consumerIdentifier}` : null,
    ].filter(Boolean);
    lines.push(`- \`${when}\` **${level}** ${clip(l.message ?? "", 500)}${ctx.length ? `  _(${ctx.join(", ")})_` : ""}`);
    if (l.attributes && Object.keys(l.attributes).length) lines.push(`  ${clip(JSON.stringify(l.attributes), 400)}`);
  }
  return lines.join("\n");
}

// ── Traces ──────────────────────────────────────────────────────────────────

export function traceToMarkdown(res: Any): string {
  const t = res.trace ?? res;
  const spans: Any[] = res.spans ?? [];
  const lines = [
    `# Trace ${t.name ?? ""}`.trim(),
    "",
    [`id: \`${t.id ?? t.traceId ?? "?"}\``, t.durationMs != null ? `${t.durationMs}ms total` : null, `${spans.length} spans`, t.startTime ? ago(t.startTime) : null]
      .filter(Boolean)
      .join(" · "),
    "",
  ];
  if (!spans.length) return lines.join("\n") + "\n(no spans)";

  // Children under parents, so the shape of the request reads top-down. Spans
  // whose parent is missing are treated as roots rather than dropped.
  const idOf = (s: Any) => s.spanId ?? s.id;
  const parentOf = (s: Any) => s.parentSpanId ?? s.parentId ?? null;
  const known = new Set(spans.map(idOf));
  const children = new Map<string | null, Any[]>();
  for (const s of spans) {
    const p = known.has(parentOf(s)) ? parentOf(s) : null;
    children.set(p, [...(children.get(p) ?? []), s]);
  }
  const byStart = (a: Any, b: Any) => new Date(a.startTime ?? 0).getTime() - new Date(b.startTime ?? 0).getTime();
  const walk = (parent: string | null, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort(byStart)) {
      const err = s.error || s.status === "error" || (s.statusCode && s.statusCode >= 500) ? " **[error]**" : "";
      lines.push(`${"  ".repeat(depth)}- ${s.name ?? s.kind ?? "span"} — ${s.durationMs ?? "?"}ms${err}`);
      if (s.errorMessage) lines.push(`${"  ".repeat(depth + 1)}${clip(s.errorMessage, 300)}`);
      walk(idOf(s), depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

// ── Requests ────────────────────────────────────────────────────────────────

export function requestToMarkdown(res: Any): string {
  const r = res.request ?? res.log ?? res;
  const lines = [`# ${r.method ?? ""} ${r.path ?? r.url ?? "request"}`.trim(), ""];
  lines.push(
    [
      r.statusCode != null ? `HTTP ${r.statusCode}` : null,
      r.responseTime != null ? `${r.responseTime}ms` : null,
      r.timestamp ? ago(r.timestamp) : null,
      r.consumerIdentifier ? `user ${r.consumerIdentifier}` : null,
      r.clientIp ? `from ${r.clientIp}${r.country ? ` (${r.country})` : ""}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
  );
  lines.push(`id: \`${r.id ?? "?"}\`${r.traceId ? ` · trace: \`${r.traceId}\`` : ""}`);
  if (r.errorMessage) lines.push("", "## Error", "", clip(r.errorMessage, 1500));
  if (r.queryParams && Object.keys(r.queryParams).length) lines.push("", "## Query", "", fence(clip(r.queryParams, 1000), "json"));
  if (r.requestHeaders) lines.push("", "## Request headers", "", fence(clip(r.requestHeaders, 1500), "json"));
  if (r.requestBody) lines.push("", "## Request body", "", fence(clip(r.requestBody, 3000), "json"));
  if (r.responseBody) lines.push("", "## Response body", "", fence(clip(r.responseBody, 3000), "json"));
  if (r.traceId) lines.push("", `Next: \`get_trace ${r.traceId}\``);
  return lines.join("\n");
}

// ── Databases ───────────────────────────────────────────────────────────────

export function databasesToMarkdown(res: { instances?: Any[] }): string {
  const rows = res.instances ?? [];
  if (!rows.length) {
    return "No databases are reporting for this app. The collector runs next to Postgres — see /docs/DATABASE.md.";
  }
  const lines = [`## ${rows.length} database(s)`, ""];
  for (const i of rows) {
    lines.push(
      `- **${i.name}** — id: \`${i.id}\`` +
        [i.engine, i.version, i.env, i.role].filter(Boolean).map((x) => ` · ${x}`).join("")
    );
  }
  lines.push("", "Next: `slow_queries <id>` for what is costing time, `db_activity <id>` for what it is waiting on.");
  return lines.join("\n");
}

export function slowQueriesToMarkdown(res: { queries?: Any[] }): string {
  const rows = res.queries ?? [];
  if (!rows.length) return "No query statistics in this window.";
  const lines = [`## ${rows.length} queries, worst first`, ""];
  rows.forEach((q, n) => {
    const mean = q.calls ? (Number(q.totalExecMs) / Number(q.calls)) : 0;
    const bits = [
      `${Math.round(Number(q.totalExecMs ?? 0))}ms total`,
      `${q.calls ?? 0} calls`,
      `${mean.toFixed(1)}ms mean`,
      q.rows != null ? `${q.rows} rows` : null,
      q.cacheHitRatio != null ? `${Number(q.cacheHitRatio).toFixed(1)}% cache` : null,
      q.tempBlksWritten ? `**${q.tempBlksWritten} temp blocks**` : null,
      q.datname ? `db ${q.datname}` : null,
    ].filter(Boolean);
    lines.push(`${n + 1}. ${bits.join(" · ")}`);
    lines.push(`   id: \`${q.queryid}\``);
    if (q.queryText) lines.push("", fence(clip(String(q.queryText).trim(), 1200), "sql"));
    const callers: Any[] = q.callers ?? [];
    if (callers.length) {
      const names = callers.map((c) => c.endpoint ?? c.path ?? c.name ?? JSON.stringify(c)).filter(Boolean);
      if (names.length) lines.push(`   called from: ${names.slice(0, 5).join(", ")}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

export function dbActivityToMarkdown(res: Any): string {
  const waits: Any[] = res.waitEvents ?? [];
  const blocking: Any[] = res.blocking ?? [];
  const longest: Any[] = res.longestRunning ?? [];
  const lines: string[] = [];

  if (waits.length) {
    const total = waits.reduce((n, w) => n + Number(w.samples ?? 0), 0) || 1;
    const byCat = new Map<string, number>();
    for (const w of waits) byCat.set(w.category, (byCat.get(w.category) ?? 0) + Number(w.samples ?? 0));
    lines.push("## What it was waiting on", "");
    for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cat} — ${((n / total) * 100).toFixed(1)}% of samples`);
    }
  } else {
    lines.push("## What it was waiting on", "", "No activity samples in this window.");
  }

  if (blocking.length) {
    lines.push("", "## Blocking", "");
    for (const b of blocking.slice(0, 10)) {
      lines.push(
        `- ${b.blocked_backends ?? "?"} backend(s) blocked, longest ${b.longest_wait_s ?? "?"}s` +
          (b.sample_query ? `\n  ${clip(String(b.sample_query).trim(), 300)}` : "")
      );
    }
  }

  if (longest.length) {
    lines.push("", "## Longest running", "");
    for (const r of longest.slice(0, 10)) {
      lines.push(
        `- ${r.query_age_s ?? "?"}s` +
          (r.xact_age_s ? ` (xact ${r.xact_age_s}s)` : "") +
          (r.query_text ? `\n  ${clip(String(r.query_text).trim(), 300)}` : "")
      );
    }
  }
  return lines.join("\n");
}

export function dbHealthToMarkdown(res: { timeSeries?: Any[] }): string {
  const rows = res.timeSeries ?? [];
  if (!rows.length) return "No instance metrics in this window.";
  const last = rows[rows.length - 1];
  const peak = (f: string) => Math.max(...rows.map((r) => Number(r[f] ?? 0)));
  const sum = (f: string) => rows.reduce((n, r) => n + Number(r[f] ?? 0), 0);
  return [
    "## Health",
    "",
    `- connections: ${last.connections ?? "?"} now, ${peak("connections")} peak`,
    `- active: ${last.active ?? "?"} · idle in transaction: ${last.idleInXact ?? "?"} (peak ${peak("idleInXact")})`,
    `- commits: ${sum("commits")} · rollbacks: ${sum("rollbacks")}`,
    `- deadlocks: ${sum("deadlocks")}${sum("deadlocks") ? "  **investigate**" : ""}`,
    `- temp bytes written: ${sum("tempBytes")}`,
    "",
    `_${rows.length} buckets in the window._`,
  ].join("\n");
}
