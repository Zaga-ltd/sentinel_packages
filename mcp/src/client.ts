// ─── Sentrinel API client ────────────────────────────────────────────────────
//
// Shared by the MCP server and the CLI: one place that knows how to talk to the
// API, so the two surfaces cannot drift apart.
//
// Credentials come from the environment and nowhere else. Not argv — every
// process on the machine can read that through `ps` — and not a config file
// this package writes, because a file it writes is a file it has to secure.
// The key is never logged, never echoed in an error, and never sent anywhere
// but the configured API.

export interface ClientConfig {
  url: string;
  key: string;
}

/** Every kind that is not an agent key, with the name the dashboard uses for it. */
const OTHER_KINDS: Record<string, string> = {
  snt_live_: "server (backend plugin)",
  snt_dev_: "server (backend plugin)",
  snt_mobile_: "mobile app",
  snt_db_: "database collector",
  snt_otlp_: "OpenTelemetry",
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): ClientConfig {
  const url = (env.SENTRINEL_API_URL || "").replace(/\/+$/, "");
  const key = env.SENTRINEL_API_KEY || "";

  if (!url) {
    throw new Error("SENTRINEL_API_URL is not set (for example https://api.sentrinel.dev).");
  }
  if (!key) {
    throw new Error(
      "SENTRINEL_API_KEY is not set. In the dashboard: API Keys → Generate → \"AI agent\"."
    );
  }
  // Refused here, before any request, so the failure names the actual cause.
  // The server would answer 401, which reads as "wrong key" rather than
  // "wrong kind of key".
  const other = Object.keys(OTHER_KINDS).find((p) => key.startsWith(p));
  if (other) {
    throw new Error(
      `SENTRINEL_API_KEY is a ${OTHER_KINDS[other]} key. An agent needs an "AI agent" key ` +
        "(snt_mcp_… or snt_mcprw_…) — every other kind deliberately cannot read. Issue one from the dashboard."
    );
  }

  // A key copied from the documentation keeps the example's ellipsis, which
  // has the right prefix and is not a key. Left to reach fetch() it fails as
  // "invalid header value", surfaced as "could not reach the API" — a network
  // error for a typo. Caught here it names the actual problem.
  const body = key.replace(/^snt_[a-z]+_/, "");
  if (!/^[A-Za-z0-9]{16,}$/.test(body)) {
    throw new Error(
      `SENTRINEL_API_KEY does not look like a key: "${key.slice(0, 12)}…". ` +
        "If you copied the example from the docs, it is a placeholder — take the real " +
        "value from the dashboard (API Keys → Generate → AI agent) and re-run the installer."
    );
  }
  return { url, key };
}

export class SentrinelError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export type Params = Record<string, string | number | boolean | undefined>;

/**
 * A window, in seconds, from what a person would write.
 *
 * The API takes `period` as a number of seconds and parses it with `parseInt`,
 * so a friendly "7d" arrives as **7 seconds** — a silently empty result rather
 * than an error. This tooling accepts the friendly form and converts, because
 * asking an agent to send 604800 is asking for that bug in a different place.
 */
export function periodSeconds(input: string | number | undefined, fallback: number): number {
  if (input === undefined || input === "") return fallback;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : fallback;
  const m = /^(\d+)\s*([smhdw]?)$/i.exec(input.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 604800;
  return n * mult;
}

export class SentrinelClient {
  constructor(
    private readonly cfg: ClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async request<T>(method: string, path: string, params: Params = {}, body?: unknown): Promise<T> {
    const url = new URL(this.cfg.url + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.key}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new SentrinelError(
        `Could not reach ${this.cfg.url}: ${err instanceof Error ? err.message : String(err)}`,
        0
      );
    }

    if (!res.ok) {
      let detail = "";
      try {
        const parsed = (await res.json()) as { error?: string };
        detail = parsed.error ?? "";
      } catch {
        /* not JSON */
      }
      throw new SentrinelError(explain(res.status, detail), res.status);
    }
    return (await res.json()) as T;
  }

  get<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, {}, body);
  }

  // ── Typed helpers, one per thing an agent asks for ──────────────────────

  listIssues(
    opts: { status?: string; period?: string | number; search?: string; limit?: number; sort?: string } = {}
  ) {
    return this.get<{ issues: any[]; counts?: Record<string, number> }>("/api/issues", {
      status: opts.status ?? "unresolved",
      period: periodSeconds(opts.period, 7 * 86400),
      search: opts.search,
      limit: opts.limit ?? 20,
      sort: opts.sort,
    });
  }

  getIssue(id: string, period?: string | number) {
    return this.get<any>(`/api/issues/${encodeURIComponent(id)}`, {
      period: periodSeconds(period, 7 * 86400),
    });
  }

  searchLogs(opts: { search?: string; level?: string; period?: string | number; limit?: number } = {}) {
    return this.get<{ logs: any[]; pagination?: any }>("/api/logs", {
      search: opts.search,
      level: opts.level,
      period: periodSeconds(opts.period, 86400),
      limit: opts.limit ?? 50,
    });
  }

  getTrace(id: string) {
    return this.get<any>(`/api/traces/${encodeURIComponent(id)}`);
  }

  getRequest(id: string) {
    return this.get<any>(`/api/requests/${encodeURIComponent(id)}`);
  }

  // ── Databases ───────────────────────────────────────────────────────────
  //
  // The collector's view of Postgres. Scoped like everything else: a key sees
  // only the databases belonging to the app it was issued for.

  listDatabases() {
    return this.get<{ instances: any[] }>("/api/databases");
  }

  slowQueries(id: string, opts: { period?: string | number; sort?: string } = {}) {
    return this.get<{ queries: any[] }>(`/api/databases/${encodeURIComponent(id)}/queries`, {
      period: periodSeconds(opts.period, 3600),
      sort: opts.sort ?? "total",
    });
  }

  dbActivity(id: string, period?: string | number) {
    return this.get<{ waitEvents: any[]; blocking: any[]; longestRunning: any[] }>(
      `/api/databases/${encodeURIComponent(id)}/activity`,
      { period: periodSeconds(period, 3600) }
    );
  }

  dbHealth(id: string, period?: string | number) {
    return this.get<{ timeSeries: any[] }>(`/api/databases/${encodeURIComponent(id)}/metrics`, {
      period: periodSeconds(period, 3600),
    });
  }

  setIssueStatus(id: string, status: "resolved" | "ignored" | "unresolved") {
    return this.patch<any>(`/api/issues/${encodeURIComponent(id)}`, { status });
  }
}

/** Turn an HTTP status into the sentence a person (or an agent) can act on. */
function explain(status: number, detail: string): string {
  switch (status) {
    case 401:
      return "The API rejected the key (401). It may have been revoked — issue a new read key from the dashboard.";
    case 403:
      return detail || "Forbidden (403). This key cannot do that — a read-only agent key cannot change issues; issue an \"AI agent — may resolve issues\" key for that.";
    case 404:
      return detail || "Not found (404).";
    default:
      return detail ? `${detail} (${status})` : `Request failed with status ${status}.`;
  }
}
