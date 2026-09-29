"use strict";
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
 * // app/api/sentrinel/route.ts  (Next)
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
 *
 * ## Browser timings are client data
 *
 * A fetch timed in the browser includes the network, the queue in the
 * browser, and whatever the page did before the request left. It is a
 * different measurement from the one the backend makes of the same call. They
 * used to be rolled up into `/api/ingest/metrics`, where they landed in the
 * same endpoint rows as the backend's (those rows have no module column), so
 * `GET /api/orders` counted every call twice and its p95 was a blend of two
 * unrelated numbers. They are now sent only as request rows marked
 * `kind: "client"` in the `web` module, and as client spans on the trace.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SENTRINEL_TUNNEL_PATHS = void 0;
exports.isSentrinelTunnelPath = isSentrinelTunnelPath;
exports.createSentrinelTunnel = createSentrinelTunnel;
const DEFAULT_MAX_BODY = 512 * 1024;
/**
 * Where the browser SDK posts by default, and where it used to.
 *
 * `/api/_sentrinel` was the old default and pages built against it are still
 * deployed; Next's App Router cannot serve it (a `_` folder is private), which
 * is why the default moved. A server mounting the tunnel by path should answer
 * both — `isSentrinelTunnelPath` does.
 */
exports.SENTRINEL_TUNNEL_PATHS = ["/api/sentrinel", "/api/_sentrinel"];
function isSentrinelTunnelPath(pathname) {
    return exports.SENTRINEL_TUNNEL_PATHS.includes(pathname.replace(/\/+$/, ""));
}
/**
 * Client spans forwarded per batch — the trace ingest's own per-call cap. They
 * travel together in one call, so a busy page costs this server one request,
 * not one per fetch.
 */
const MAX_CLIENT_SPANS = 500;
/** The trace payload for a request the page propagated, or null if it did not. */
function clientSpan(r) {
    const traceId = typeof r.traceId === "string" ? r.traceId : null;
    const spanId = typeof r.spanId === "string" ? r.spanId : null;
    if (!traceId || !spanId || !/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId))
        return null;
    const start = new Date(String(r.timestamp ?? ""));
    if (Number.isNaN(start.getTime()))
        return null;
    const durationMs = Math.max(0, Number(r.responseTime) || 0);
    const status = Number(r.statusCode) || 0;
    const name = `${String(r.method ?? "GET")} ${String(r.path ?? "/")}`.slice(0, 200);
    const statusCode = status === 0 || status >= 500 ? "ERROR" : "OK";
    const attrs = (r.attributes && typeof r.attributes === "object" ? r.attributes : {});
    return {
        traceId,
        requestLogId: typeof r.id === "string" ? r.id : undefined,
        name,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + durationMs).toISOString(),
        durationMs,
        statusCode: status,
        spans: [
            {
                id: spanId,
                traceId,
                parentId: null,
                name,
                kind: "CLIENT",
                startTime: start.toISOString(),
                endTime: new Date(start.getTime() + durationMs).toISOString(),
                durationMs,
                statusCode,
                attributes: {
                    "sentrinel.source": "browser",
                    "sentrinel.kind": "client",
                    "http.method": r.method,
                    "http.route": r.path,
                    "http.status_code": status,
                    ...(r.consumerIdentifier ? { "sentrinel.consumer": r.consumerIdentifier } : {}),
                    ...(attrs["device.id"] ? { "device.id": attrs["device.id"] } : {}),
                },
            },
        ],
    };
}
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
const LIMITS = { errors: 2000, requests: 5000, sessions: 1000, events: 5000 };
/**
 * Build the handler.
 *
 * Always answers `202` when the batch is well-formed, even if forwarding fails.
 * The page cannot do anything useful with a delivery failure, and an error
 * response would show up as a failed request in its own console — noise about
 * monitoring, in place of the app's own signal.
 */
function createSentrinelTunnel(options) {
    const { serverUrl, appName, env, apiKey, release, module = "web", maxBodyBytes = DEFAULT_MAX_BODY, maxReplayBytes = DEFAULT_MAX_REPLAY_BODY, consumerIdentifier, beforeForward, debug, } = options;
    const base = serverUrl.replace(/\/$/, "");
    const log = (...args) => {
        if (debug)
            console.log("[sentrinel:tunnel]", ...args);
    };
    return async function handle(request) {
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
        let raw;
        try {
            raw = await request.text();
        }
        catch {
            return json({ error: "Unreadable body" }, 400);
        }
        if (raw.length > Math.max(maxBodyBytes, maxReplayBytes)) {
            return json({ error: "Batch too large" }, 413);
        }
        let batch;
        try {
            batch = JSON.parse(raw);
        }
        catch {
            return json({ error: "Invalid JSON" }, 400);
        }
        if (!batch || typeof batch !== "object")
            return json({ error: "Invalid batch" }, 400);
        // Now that the shape is known, hold a plain record batch to the tighter
        // limit. Only a replay chunk is allowed to be large.
        if (!batch.replay && raw.length > maxBodyBytes) {
            return json({ error: "Batch too large" }, 413);
        }
        if (beforeForward) {
            const kept = beforeForward(batch, request);
            if (!kept)
                return json({ accepted: 0 }, 202);
            batch = kept;
        }
        const consumer = consumerIdentifier ? await safe(() => consumerIdentifier(request)) : undefined;
        const effectiveRelease = release ?? batch.release;
        const errors = take(batch.errors, LIMITS.errors).map((e) => ({
            ...e,
            ...(consumer ? { consumerIdentifier: consumer } : {}),
            ...(effectiveRelease ? { attributes: withRelease(e.attributes, effectiveRelease) } : {}),
        }));
        // Marked as client measurements, so nothing downstream mistakes a timing
        // taken in the browser for the server's own.
        const requests = take(batch.requests, LIMITS.requests).map((r) => ({
            ...r,
            kind: "client",
            attributes: {
                ...(r.attributes && typeof r.attributes === "object" ? r.attributes : {}),
                "sentrinel.kind": "client",
            },
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
                module,
                env,
                ...batch.replay,
                release: effectiveRelease,
            });
            return json({ accepted: 1 }, 202);
        }
        const sends = [];
        if (errors.length)
            sends.push(forward("/api/ingest/errors", { appName, module, env, errors }));
        if (requests.length) {
            sends.push(forward("/api/ingest/requests", { appName, module, env, requests }));
            // A call the page sent a traceparent on is where a trace starts: the
            // backend's span continues it by parent id. Forwarded as a client span so
            // the click itself is on the waterfall — without it the trace begins at
            // the server and the browser's part of the journey is invisible. All of
            // them in one batched call.
            const traces = requests
                .map((r) => clientSpan(r))
                .filter((t) => t !== null)
                .slice(0, MAX_CLIENT_SPANS);
            if (traces.length)
                sends.push(forward("/api/ingest/traces", { appName, module, env, traces }));
        }
        if (sessions.length)
            sends.push(forward("/api/ingest/sessions", { appName, module, env, sessions }));
        if (events.length) {
            sends.push(forward("/api/ingest/events", {
                appName,
                module,
                env,
                release: effectiveRelease,
                anonymousId: batch.anonymousId,
                userId: consumer ?? batch.userId,
                sessionId: batch.sessionId,
                events,
            }));
        }
        // Not awaited on the page's behalf — but awaited here, because a serverless
        // function that returns first may be frozen before the fetch completes.
        await Promise.allSettled(sends);
        return json({ accepted: errors.length + requests.length + sessions.length + events.length }, 202);
        async function forward(path, payload) {
            try {
                const res = await fetch(`${base}${path}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) {
                    const detail = (await res.text().catch(() => "")).slice(0, 300);
                    console.warn(`[sentrinel:tunnel] ${path} rejected (${res.status}). ` +
                        `Check apiKey, appName "${appName}" and env "${env}". ${detail}`);
                    return;
                }
                log(path, "ok");
            }
            catch (err) {
                console.warn(`[sentrinel:tunnel] cannot reach ${base}${path} — ${err?.message ?? err}`);
            }
        }
    };
}
function withRelease(attributes, release) {
    const base = attributes && typeof attributes === "object" ? attributes : {};
    return { ...base, release: base.release ?? release };
}
function take(value, limit) {
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => v && typeof v === "object").slice(0, limit);
}
async function safe(fn) {
    try {
        return await fn();
    }
    catch {
        // A throwing identity function should cost the batch its consumer, not the
        // whole batch.
        return undefined;
    }
}
function json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
