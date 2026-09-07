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

  listIssues(opts: { status?: string; period?: string; search?: string; limit?: number } = {}) {
    return this.get<{ issues: any[]; counts?: Record<string, number> }>("/api/issues", {
      status: opts.status ?? "unresolved",
      period: opts.period ?? "7d",
      search: opts.search,
      limit: opts.limit ?? 20,
    });
  }

  getIssue(id: string, period = "7d") {
    return this.get<any>(`/api/issues/${encodeURIComponent(id)}`, { period });
  }

  searchLogs(opts: { search?: string; level?: string; period?: string; limit?: number } = {}) {
    return this.get<{ logs: any[]; pagination?: any }>("/api/logs", {
      search: opts.search,
      level: opts.level,
      period: opts.period ?? "24h",
      limit: opts.limit ?? 50,
    });
  }

  getTrace(id: string) {
    return this.get<any>(`/api/traces/${encodeURIComponent(id)}`);
  }

  getRequest(id: string) {
    return this.get<any>(`/api/requests/${encodeURIComponent(id)}`);
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
