// src/tunnel.ts
var DEFAULT_MAX_BODY = 512 * 1024;
var SENTRINEL_TUNNEL_PATHS = ["/api/sentrinel", "/api/_sentrinel"];
function isSentrinelTunnelPath(pathname) {
  return SENTRINEL_TUNNEL_PATHS.includes(pathname.replace(/\/+$/, ""));
}
var MAX_CLIENT_SPANS = 500;
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
  const attrs = r.attributes && typeof r.attributes === "object" ? r.attributes : {};
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
          ...r.consumerIdentifier ? { "sentrinel.consumer": r.consumerIdentifier } : {},
          ...attrs["device.id"] ? { "device.id": attrs["device.id"] } : {}
        }
      }
    ]
  };
}
var DEFAULT_MAX_REPLAY_BODY = 4 * 1024 * 1024;
var LIMITS = { errors: 2000, requests: 5000, sessions: 1000, events: 5000 };
function createSentrinelTunnel(options) {
  const {
    serverUrl,
    appName,
    env,
    apiKey,
    release,
    module = "web",
    maxBodyBytes = DEFAULT_MAX_BODY,
    maxReplayBytes = DEFAULT_MAX_REPLAY_BODY,
    consumerIdentifier,
    beforeForward,
    debug
  } = options;
  const base = serverUrl.replace(/\/$/, "");
  const log = (...args) => {
    if (debug)
      console.log("[sentrinel:tunnel]", ...args);
  };
  return async function handle(request) {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > Math.max(maxBodyBytes, maxReplayBytes)) {
      return json({ error: "Batch too large" }, 413);
    }
    let raw;
    try {
      raw = await request.text();
    } catch {
      return json({ error: "Unreadable body" }, 400);
    }
    if (raw.length > Math.max(maxBodyBytes, maxReplayBytes)) {
      return json({ error: "Batch too large" }, 413);
    }
    let batch;
    try {
      batch = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!batch || typeof batch !== "object")
      return json({ error: "Invalid batch" }, 400);
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
      ...consumer ? { consumerIdentifier: consumer } : {},
      ...effectiveRelease ? { attributes: withRelease(e.attributes, effectiveRelease) } : {}
    }));
    const requests = take(batch.requests, LIMITS.requests).map((r) => ({
      ...r,
      kind: "client",
      attributes: {
        ...r.attributes && typeof r.attributes === "object" ? r.attributes : {},
        "sentrinel.kind": "client"
      },
      ...consumer ? { consumerIdentifier: consumer } : {}
    }));
    const sessions = take(batch.sessions, LIMITS.sessions).map((s) => ({
      ...s,
      ...effectiveRelease ? { release: s.release ?? effectiveRelease } : {},
      ...consumer ? { userId: consumer } : {}
    }));
    const events = take(batch.events, LIMITS.events).map((e) => ({
      ...e,
      ...consumer ? { userId: consumer } : {}
    }));
    if (batch.replay) {
      await forward("/api/ingest/replay", {
        appName,
        module,
        env,
        ...batch.replay,
        release: effectiveRelease
      });
      return json({ accepted: 1 }, 202);
    }
    const sends = [];
    if (errors.length)
      sends.push(forward("/api/ingest/errors", { appName, module, env, errors }));
    if (requests.length) {
      sends.push(forward("/api/ingest/requests", { appName, module, env, requests }));
      const traces = requests.map((r) => clientSpan(r)).filter((t) => t !== null).slice(0, MAX_CLIENT_SPANS);
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
        events
      }));
    }
    await Promise.allSettled(sends);
    return json({ accepted: errors.length + requests.length + sessions.length + events.length }, 202);
    async function forward(path, payload) {
      try {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          console.warn(`[sentrinel:tunnel] ${path} rejected (${res.status}). ` + `Check apiKey, appName "${appName}" and env "${env}". ${detail}`);
          return;
        }
        log(path, "ok");
      } catch (err) {
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
  } catch {
    return;
  }
}
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
export {
  SENTRINEL_TUNNEL_PATHS,
  createSentrinelTunnel,
  isSentrinelTunnelPath
};
