// ─── FieldOps web console ────────────────────────────────────────────────────
//
// The dispatcher's side of FieldOps: a browser page that lists work orders and
// starts and completes them. It is the third part of the one project — the
// backend reports as "backend", the phone as "mobile", and this page as "web",
// all into the same Sentrinel app.
//
// The page never talks to Sentrinel directly. It posts to /api/sentrinel on this
// server, which holds the key and forwards (the tunnel), so the key is never in
// the browser. And it never talks to the backend directly either: /api/v1/* is
// proxied, which makes the page's calls same-origin — so the browser SDK adds a
// traceparent to each one, and a click here, the backend handler it reached and
// the work that handler did appear as one trace.
//
//   SENTRINEL_KEY=snt_dev_… bun run examples/fieldops/web/server.ts
//   open http://localhost:4500
//
// Environment:
//   SENTRINEL_URL      the Sentrinel API                  (default http://localhost:3001)
//   SENTRINEL_KEY      a server key for the fieldops app  (required unless keyless)
//   FIELDOPS_API       the FieldOps backend               (default http://localhost:4400)
//   FIELDOPS_WEB_PORT  this server                        (default 4500)
//   FIELDOPS_ENV       env to report as                   (default dev)

import { createSentrinelTunnel } from "@sentrinel/plugin/tunnel";

const SENTRINEL_URL = process.env.SENTRINEL_URL ?? "http://localhost:3001";
const KEY = process.env.SENTRINEL_KEY ?? "";
const BACKEND = (process.env.FIELDOPS_API ?? "http://localhost:4400").replace(/\/$/, "");
const PORT = Number(process.env.FIELDOPS_WEB_PORT ?? 4500);
const ENV = process.env.FIELDOPS_ENV ?? "dev";
const APP = process.env.FIELDOPS_APP ?? "fieldops";
const RELEASE = "fieldops-web@2.4.0";

const tunnel = createSentrinelTunnel({
  serverUrl: SENTRINEL_URL,
  appName: APP,
  // Which part of the project this is. The backend is "backend", the phone "mobile".
  module: "web",
  env: ENV,
  apiKey: KEY,
  release: RELEASE,
  // A real console reads the signed-in dispatcher from its own session. Whatever
  // the page claims is discarded either way.
  consumerIdentifier: () => "dispatch-console",
});

// The client is TypeScript; bundled for the browser once, at boot.
const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/client.ts`], target: "browser" });
if (!bundle.success) {
  console.error(bundle.logs.join("\n"));
  process.exit(1);
}
const clientJs = await bundle.outputs[0].text();

/** Request headers worth passing on. traceparent is the one that joins the trace. */
const FORWARD = ["content-type", "traceparent", "tracestate", "baggage"];

async function proxy(request: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The console is one consumer of the backend, whoever is using it.
  headers.set("x-consumer-id", "dispatch-console");
  try {
    const res = await fetch(`${BACKEND}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: `The FieldOps backend is not reachable at ${BACKEND}` }, { status: 502 });
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FieldOps dispatch</title>
<style>
  :root { color-scheme: light dark; --accent: #0f766e }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 58rem; margin: 3rem auto; padding: 0 1.25rem }
  h1 { font-size: 1.5rem; margin: 0 }
  .sub { opacity: .65; margin: .25rem 0 1.5rem }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem }
  button { font: inherit; padding: .4rem .8rem; border-radius: .5rem; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
           background: none; cursor: pointer }
  button.primary { background: var(--accent); color: white; border-color: var(--accent) }
  button:disabled { opacity: .5; cursor: default }
  table { width: 100%; border-collapse: collapse }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent) }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6 }
  td.actions { text-align: right; white-space: nowrap }
  .pill { font-size: .75rem; padding: .1rem .45rem; border-radius: 99px; background: color-mix(in srgb, var(--accent) 15%, transparent) }
  pre { background: #1c1b19; color: #e8e6df; padding: .9rem; border-radius: .6rem; font-size: .8rem; min-height: 5rem; overflow-x: auto }
</style>
</head>
<body>
  <h1>FieldOps dispatch</h1>
  <p class="sub">The web part of the <code>${APP}</code> project · env <code>${ENV}</code> · backend <code>${BACKEND}</code></p>

  <div class="bar">
    <button class="primary" id="refresh">Refresh jobs</button>
    <button id="summary">Load the dashboard summary</button>
    <button id="conflict">Complete a finished job (409)</button>
    <button id="crash">Throw in the page</button>
  </div>

  <table>
    <thead><tr><th>Job</th><th>Status</th><th>Priority</th><th></th></tr></thead>
    <tbody id="jobs"><tr><td colspan="4">loading…</td></tr></tbody>
  </table>

  <h2>What happened</h2>
  <pre id="log">ready</pre>

  <script type="module">${clientJs}</script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // The endpoint the SDK posts to. The key never leaves this process.
    if (url.pathname === "/api/sentrinel") return tunnel(request);
    if (url.pathname.startsWith("/api/v1/")) return proxy(request, url);
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`
  FieldOps web console
  ────────────────────
  page       http://localhost:${PORT}
  backend    ${BACKEND}
  reporting  ${SENTRINEL_URL}  (app ${APP}, module web, env ${ENV})
  key        ${KEY ? `set, ${KEY.length} chars` : "NOT SET — ingest will be refused"}
`);
