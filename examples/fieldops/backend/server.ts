// ─── FieldOps API ────────────────────────────────────────────────────────────
//
// A field-service platform, instrumented end to end with @sentrinel/plugin.
// It exists to exercise every Sentrinel feature at once: 40+ paths of ordinary
// CRUD, deliberate error paths, slow analytics, nested spans, structured logs,
// payload capture, consumer attribution, and trace continuation from the
// Flutter client so a tap on a phone and the server work it caused appear on
// one timeline.
//
//   bun run examples/fieldops/backend/server.ts
//
// Environment:
//   SENTRINEL_URL   where the Sentrinel API lives   (default http://localhost:3001)
//   SENTRINEL_KEY   ingest key for this app         (required unless keyless)
//   FIELDOPS_PORT   port to listen on               (default 4400)
//   FIELDOPS_ENV    env this reports as             (default dev)
//   FIELDOPS_APP    the project it reports into     (default fieldops)

import { Elysia } from "elysia";
import { sentrinelPlugin, getLogger } from "@sentrinel/plugin";

import { authRoutes } from "./domains/auth";
import { technicianRoutes } from "./domains/technicians";
import { customerRoutes } from "./domains/customers";
import { workOrderRoutes } from "./domains/workorders";
import { inventoryRoutes } from "./domains/inventory";
import { billingRoutes } from "./domains/billing";
import { analyticsRoutes } from "./domains/analytics";
import { mobileRoutes } from "./domains/mobile";
import { opsRoutes } from "./domains/ops";
import { assistRoutes } from "./domains/assist";
import { rawStore } from "./store";

const PORT = Number(process.env.FIELDOPS_PORT ?? 4400);
const SENTRINEL_URL = process.env.SENTRINEL_URL ?? "http://localhost:3001";
const API_KEY = process.env.SENTRINEL_KEY ?? "";
const ENV = process.env.FIELDOPS_ENV ?? "dev";
// The project. The backend and the phone report into this one app as two parts of
// it, so a job synced from the phone can be followed into the request and the
// query it produced. Overridable so a second copy can report into a scratch app.
const APP_NAME = process.env.FIELDOPS_APP ?? "fieldops";

const log = getLogger(["fieldops", "boot"]);

export const app = new Elysia()
  .use(
    sentrinelPlugin({
      serverUrl: SENTRINEL_URL,
      appName: APP_NAME,
      // Which part of the project this is. The phone reports as "mobile".
      module: "backend",
      env: ENV,
      apiKey: API_KEY || undefined,
      version: "2.4.0",
      // Short, so a demo run shows up in the dashboard in seconds rather than
      // after the default half-minute.
      flushInterval: 2_000,
      debug: process.env.FIELDOPS_DEBUG === "true",

      // Health checks would otherwise drown the endpoint table.
      excludePaths: ["/health", "/favicon.ico"],

      // Who is calling. The Flutter app sends x-technician-id; the simulator
      // spreads traffic across several of these so Consumers has real spread.
      // The richer shape: a stable id to join on, a name to read, and the
      // segment to slice by. Contact details are deliberately absent — the id
      // is enough to look someone up in the system that legitimately holds
      // them.
      consumerIdentifier: (ctx) => {
        const id =
          ctx.request.headers.get("x-technician-id") ||
          ctx.request.headers.get("x-consumer-id");
        if (!id) return "anonymous";
        return {
          identifier: id,
          name: id.startsWith("tech-") ? `Technician ${id.slice(5)}` : id,
          group: id.startsWith("tech-") ? "field" : "back-office",
        };
      },

      requestLogging: {
        enabled: true,
        sampleRate: 1.0,
        slowRequestThresholdMs: 400,
        logRequestHeaders: true,
        logRequestBody: true,
        logResponseBody: true,
        captureLogs: true,
        maxBodySize: 64_000,
        maskHeaders: [/^authorization$/i, /^cookie$/i, /^x-api-key$/i],
        maskQueryParams: [/^token$/i, /^secret$/i],
        maskBodyFields: [/^password$/i, /^token$/i, /^pin$/i, /^dataBase64$/i],
      },
    })
  )
  .use(opsRoutes)
  .use(assistRoutes)
  .use(authRoutes)
  .use(technicianRoutes)
  .use(customerRoutes)
  .use(workOrderRoutes)
  .use(inventoryRoutes)
  .use(billingRoutes)
  .use(analyticsRoutes)
  .use(mobileRoutes);

if (import.meta.main) {
  app.listen(PORT);

  const routes = app.routes.length;
  log.info("fieldops api listening", { port: PORT, routes, env: ENV });

  console.log(`
  FieldOps API
  ────────────────────────────────────────────────────────
  listening   http://localhost:${PORT}
  routes      ${routes}
  reporting   ${SENTRINEL_URL}  (app "${APP_NAME}", env "${ENV}")
  ingest key  ${API_KEY ? `set, ${API_KEY.length} chars` : "NOT SET — ingest will 403"}
  seeded      ${rawStore.customers.size} customers · ${rawStore.technicians.size} technicians · ${rawStore.workOrders.size} jobs · ${rawStore.parts.size} parts

  Drive it:   bun run examples/fieldops/simulate.ts
`);
}
