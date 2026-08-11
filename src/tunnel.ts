/**
 * Browser tunnel — `@sentrinel/plugin/tunnel`
 *
 * The server half of the browser SDK: one `Request → Response` handler that
 * takes a batch from the page and forwards it to Sentrinel with your API key.
 *
 * It exists so the key never ships in a bundle. It also **pins `appName` and
 * `env` here**, ignoring anything the browser claims, so a page — or anyone who
 * found the endpoint — cannot write telemetry into a different app.
 *
 * It is a plain `(Request) => Promise<Response>`, which is what Bun, Elysia,
 * Hono, Next route handlers, TanStack Start, Remix and Deno all speak.
 *
 * ```ts
 * // app/api/_sentrinel/route.ts  (Next)
 * import { createSentrinelTunnel } from "@sentrinel/plugin/tunnel";
 *
 * const tunnel = createSentrinelTunnel({
 *   serverUrl: "https://api.sentrinel.dev",
 *   appName: "admin",
 *   env: "prod",
 *   apiKey: process.env.SENTRINEL_API_KEY!,
 * });
 *
 * export const POST = tunnel;
 * ```
 */

import { rollUpConsumers, rollUpEndpoints, type RollupRequest } from "./rollup";

export interface SentrinelTunnelOptions {
  /** The Sentrinel API, e.g. `https://api.sentrinel.dev`. */
  serverUrl: string;
  /** Pinned server-side; whatever the browser sends is ignored. */
  appName: string;
  /** Pinned server-side. Must match the environment the key was issued for. */
  env: string;
  /** Never let this reach the client. */
  apiKey: string;
  /** Falls back to the release the browser reported. */
  release?: string;
  /**
   * Largest batch accepted, in bytes. An open endpoint that will buffer
   * anything is a memory-exhaustion target.
   */
  maxBodyBytes?: number;
  /** Ceiling for a session-replay chunk. Defaults to 4MB. */
  maxReplayBytes?: number;
  /**
   * Who sent this, derived from the request — a session cookie, a header, an
   * authenticated user. Overrides whatever the browser claimed, because a
   * browser-supplied identity is a claim, not a fact.
   */
  consumerIdentifier?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Last chance to drop or redact server-side. Return `null` to drop the batch. */
  beforeForward?: (batch: TunnelBatch, request: Request) => TunnelBatch | null;
  /** Log forwarding results. */
  debug?: boolean;
}

export interface TunnelBatch {
  release?: string;
  errors?: Record<string, unknown>[];
  requests?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  anonymousId?: string;
  userId?: string;
  sessionId?: string;
  /** A session-replay chunk. Arrives alone, and is far larger than the rest. */
  replay?: Record<string, unknown>;
}

const DEFAULT_MAX_BODY = 512 * 1024;

/**
 * Separate, larger ceiling for session-replay chunks.
 *
 * A record batch that reaches half a megabyte is a runaway loop, so the small
 * default is a useful alarm. A replay chunk is a DOM snapshot and *starts*
 * near that size — holding it to the same limit would reject the feature
 * rather than protect anything. Matches MAX_CHUNK_BYTES on the ingest side, so
 * a payload that passes here is not rejected one hop later.
 */
const DEFAULT_MAX_REPLAY_BODY = 4 * 1024 * 1024;

/** Caps mirroring the ingest endpoints, applied before anything leaves. */
const LIMITS = { errors: 2_000, requests: 5_000, sessions: 1_000, events: 5_000 } as const;

/**
 * Build the handler.
 *
 * Always answers `202` when the batch is well-formed, even if forwarding fails.
 * The page cannot do anything useful with a delivery failure, and an error
 * response would show up as a failed request in its own console — noise about
 * monitoring, in place of the app's own signal.
 */
export function createSentrinelTunnel(
  options: SentrinelTunnelOptions
): (request: Request) => Promise<Response> {
  const {
    serverUrl,
    appName,
    env,
    apiKey,
    release,
    maxBodyBytes = DEFAULT_MAX_BODY,
    maxReplayBytes = DEFAULT_MAX_REPLAY_BODY,
    consumerIdentifier,
    beforeForward,
    debug,
  } = options;

  const base = serverUrl.replace(/\/$/, "");
  const log = (...args: unknown[]) => {
    if (debug) console.log("[sentrinel:tunnel]", ...args);
  };

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    // Check the declared length before reading, so an oversized body is
    // rejected rather than buffered.
    // Checked against the larger ceiling because the kind of payload is not
    // known until it is parsed; the tighter record-batch limit is applied below.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > Math.max(maxBodyBytes, maxReplayBytes)) {
      return json({ error: "Batch too large" }, 413);
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return json({ error: "Unreadable body" }, 400);
    }
    if (raw.length > Math.max(maxBodyBytes, maxReplayBytes)) {
      return json({ error: "Batch too large" }, 413);
    }

    let batch: TunnelBatch;
    try {
      batch = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!batch || typeof batch !== "object") return json({ error: "Invalid batch" }, 400);

    // Now that the shape is known, hold a plain record batch to the tighter
    // limit. Only a replay chunk is allowed to be large.
    if (!batch.replay && raw.length > maxBodyBytes) {
      return json({ error: "Batch too large" }, 413);
    }

    if (beforeForward) {
      const kept = beforeForward(batch, request);
      if (!kept) return json({ accepted: 0 }, 202);
      batch = kept;
    }

    const consumer = consumerIdentifier ? await safe(() => consumerIdentifier(request)) : undefined;
    const effectiveRelease = release ?? batch.release;

    const errors = take(batch.errors, LIMITS.errors).map((e) => ({
      ...e,
      ...(consumer ? { consumerIdentifier: consumer } : {}),
      ...(effectiveRelease ? { attributes: withRelease(e.attributes, effectiveRelease) } : {}),
    }));
    const requests = take(batch.requests, LIMITS.requests).map((r) => ({
      ...r,
      ...(consumer ? { consumerIdentifier: consumer } : {}),
    }));
    const sessions = take(batch.sessions, LIMITS.sessions).map((s) => ({
      ...s,
      ...(effectiveRelease ? { release: s.release ?? effectiveRelease } : {}),
      ...(consumer ? { userId: consumer } : {}),
    }));
    // Product events. The server-side consumer wins over whatever the page
    // claimed, exactly as it does for sessions — a page can assert any user id,
    // and this endpoint is the only place that knows who is really signed in.
    const events = take(batch.events, LIMITS.events).map((e) => ({
      ...e,
      ...(consumer ? { userId: consumer } : {}),
    }));

    // A replay chunk arrives alone, in its own request — see BatchPayload.
    // Forwarded first because it is the one payload with a size limit worth
    // failing fast on.
    if (batch.replay) {
      await forward("/api/ingest/replay", {
        appName,
        env,
        ...batch.replay,
        release: effectiveRelease,
      });
      return json({ accepted: 1 }, 202);
    }

    const sends: Promise<void>[] = [];
    if (errors.length) sends.push(forward("/api/ingest/errors", { appName, env, errors }));
    if (requests.length) {
      sends.push(forward("/api/ingest/requests", { appName, env, requests }));
      // The same requests, aggregated. Both are needed and they are not
      // interchangeable: the rows above are the log view, and this is every
      // headline number on the Apps and Overview pages. Derived here rather
      // than in the page so a browser SDK ships no extra bytes for it, and so
      // the arithmetic stays next to the server's — see rollup.ts.
      sends.push(
        forward("/api/ingest/metrics", {
          appName,
          env,
          timestamp: new Date().toISOString(),
          endpoints: rollUpEndpoints(requests as unknown as RollupRequest[]),
          consumers: rollUpConsumers(requests as unknown as RollupRequest[]),
        }),
      );
    }
    if (sessions.length) sends.push(forward("/api/ingest/sessions", { appName, env, sessions }));
    if (events.length) {
      sends.push(
        forward("/api/ingest/events", {
          appName,
          env,
          release: effectiveRelease,
          anonymousId: batch.anonymousId,
          userId: consumer ?? batch.userId,
          sessionId: batch.sessionId,
          events,
        })
      );
    }

    // Not awaited on the page's behalf — but awaited here, because a serverless
    // function that returns first may be frozen before the fetch completes.
    await Promise.allSettled(sends);

    return json(
      { accepted: errors.length + requests.length + sessions.length + events.length },
      202
    );

    async function forward(path: string, payload: unknown): Promise<void> {
      try {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          console.warn(
            `[sentrinel:tunnel] ${path} rejected (${res.status}). ` +
              `Check apiKey, appName "${appName}" and env "${env}". ${detail}`
          );
          return;
        }
        log(path, "ok");
      } catch (err) {
        console.warn(
          `[sentrinel:tunnel] cannot reach ${base}${path} — ${(err as Error)?.message ?? err}`
        );
      }
    }
  };
}

function withRelease(
  attributes: unknown,
  release: string
): Record<string, unknown> {
  const base = attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  return { ...base, release: base.release ?? release };
}

function take(value: unknown, limit: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => v && typeof v === "object").slice(0, limit) as Record<string, unknown>[];
}

async function safe<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    // A throwing identity function should cost the batch its consumer, not the
    // whole batch.
    return undefined;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
