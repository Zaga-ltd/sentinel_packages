// ─── FieldOps traffic simulator ──────────────────────────────────────────────
//
// Drives every route on the FieldOps backend with a realistic CRUD mix, so a
// fresh Sentrinel install has something on every page within a minute or two.
//
//   bun run examples/fieldops/simulate.ts
//   bun run examples/fieldops/simulate.ts --duration 300 --rps 25
//
// It deliberately produces:
//   * a long tail of slow analytics requests, for the p95/apdex panels
//   * a steady error floor across 4xx and 5xx, for Errors and Issues
//   * several distinct exception classes, so Issues has groups to separate
//   * traffic from a dozen consumers, for the Consumers page
//   * fat request bodies, for payload capture
//
// The backend must already be running; this only makes requests.

const BASE = process.env.FIELDOPS_API ?? "http://localhost:4400";

const args = process.argv.slice(2);
function arg(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const DURATION_S = arg("duration", 120);
const TARGET_RPS = arg("rps", 20);

/** A dozen technicians plus a few machine callers. */
const CONSUMERS = [
  ...Array.from({ length: 10 }, (_, i) => `tech-${String(i + 1).padStart(2, "0")}`),
  "dispatch-console",
  "billing-cron",
  "partner-integration",
];

interface Stat {
  sent: number;
  byStatus: Map<number, number>;
  failed: number;
}
const stat: Stat = { sent: 0, byStatus: new Map(), failed: 0 };

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  consumer = pick(CONSUMERS)
): Promise<any> {
  const url = `${BASE}${path}`;
  stat.sent++;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-technician-id": consumer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    stat.byStatus.set(res.status, (stat.byStatus.get(res.status) ?? 0) + 1);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err) {
    stat.failed++;
    return null;
  }
}

// ─── Reference data, refreshed as the run goes ───────────────────────────────

let technicianIds: string[] = [];
let customerIds: string[] = [];
let partIds: string[] = [];
let workOrderIds: string[] = [];
let invoiceIds: string[] = [];

async function refresh(): Promise<void> {
  const [techs, customers, parts, jobs] = await Promise.all([
    call("GET", "/api/v1/technicians"),
    call("GET", "/api/v1/customers"),
    call("GET", "/api/v1/parts"),
    call("GET", "/api/v1/workorders"),
  ]);
  technicianIds = (techs?.technicians ?? []).map((t: any) => t.id);
  customerIds = (customers?.customers ?? []).map((c: any) => c.id);
  partIds = (parts?.parts ?? []).map((p: any) => p.id);
  workOrderIds = (jobs?.workOrders ?? []).map((w: any) => w.id);
}

// ─── Scenarios ───────────────────────────────────────────────────────────────
//
// Weights decide the traffic shape. Reads dominate, as they do in real life;
// the failure scenarios are frequent enough to populate a dashboard but not so
// frequent that the error rate stops meaning anything.

type Scenario = { weight: number; name: string; run: () => Promise<void> };

const SCENARIOS: Scenario[] = [
  // ── Reads ────────────────────────────────────────────────────────────────
  { weight: 10, name: "list jobs", run: async () => {
    const status = pick(["", "draft", "scheduled", "in_progress", "completed"]);
    await call("GET", `/api/v1/workorders${status ? `?status=${status}` : ""}`);
  }},
  { weight: 8, name: "read job", run: async () => {
    if (!workOrderIds.length) return;
    await call("GET", `/api/v1/workorders/${pick(workOrderIds)}`);
  }},
  { weight: 7, name: "list technicians", run: async () => {
    await call("GET", "/api/v1/technicians");
  }},
  { weight: 6, name: "technician schedule", run: async () => {
    if (!technicianIds.length) return;
    await call("GET", `/api/v1/technicians/${pick(technicianIds)}/schedule`);
  }},
  { weight: 7, name: "list customers", run: async () => {
    await call("GET", `/api/v1/customers?tier=${pick(["free", "pro", "enterprise"])}`);
  }},
  { weight: 5, name: "customer sites", run: async () => {
    if (!customerIds.length) return;
    await call("GET", `/api/v1/customers/${pick(customerIds)}/sites`);
  }},
  { weight: 6, name: "list parts", run: async () => {
    await call("GET", `/api/v1/parts${Math.random() < 0.3 ? "?lowStock=true" : ""}`);
  }},
  { weight: 4, name: "read part", run: async () => {
    if (!partIds.length) return;
    await call("GET", `/api/v1/parts/${pick(partIds)}`);
  }},
  { weight: 5, name: "mobile bootstrap", run: async () => {
    if (!technicianIds.length) return;
    await call("GET", `/api/v1/mobile/bootstrap?technicianId=${pick(technicianIds)}`);
  }},
  { weight: 3, name: "notifications", run: async () => {
    await call("GET", "/api/v1/mobile/notifications?unreadOnly=true");
  }},
  { weight: 3, name: "invoices", run: async () => {
    await call("GET", "/api/v1/invoices");
  }},

  // ── Slow analytics — the p95 tail ────────────────────────────────────────
  { weight: 3, name: "analytics summary", run: async () => {
    await call("GET", "/api/v1/analytics/summary");
  }},
  { weight: 2, name: "revenue report", run: async () => {
    await call("GET", "/api/v1/analytics/revenue");
  }},
  { weight: 2, name: "utilization report", run: async () => {
    await call("GET", "/api/v1/analytics/technician-utilization");
  }},
  { weight: 2, name: "SLA report", run: async () => {
    await call("GET", "/api/v1/analytics/sla", undefined, "dispatch-console");
  }},
  { weight: 3, name: "search", run: async () => {
    await call("GET", `/api/v1/search?q=${pick(["Customer", "Job", "Tech", "1"])}`);
  }},

  // ── Writes ───────────────────────────────────────────────────────────────
  { weight: 4, name: "create job", run: async () => {
    if (!customerIds.length) return;
    const customerId = pick(customerIds);
    const sites = await call("GET", `/api/v1/customers/${customerId}/sites`);
    const siteId = sites?.sites?.[0]?.id;
    if (!siteId) return;
    const created = await call("POST", "/api/v1/workorders", {
      customerId,
      siteId,
      title: `Job ${Math.floor(Math.random() * 10_000)}`,
      priority: pick(["low", "normal", "high", "urgent"]),
    });
    if (created?.id) workOrderIds.push(created.id);
  }},
  { weight: 3, name: "assign + start job", run: async () => {
    if (!workOrderIds.length || !technicianIds.length) return;
    const woId = pick(workOrderIds);
    await call("POST", `/api/v1/workorders/${woId}/assign`, {
      technicianId: pick(technicianIds),
    });
    await call("POST", `/api/v1/workorders/${woId}/start`);
  }},
  { weight: 3, name: "complete job (deep trace)", run: async () => {
    if (!workOrderIds.length) return;
    const res = await call("POST", `/api/v1/workorders/${pick(workOrderIds)}/complete`, {
      labourMinutes: 30 + Math.floor(Math.random() * 180),
    });
    if (res?.invoice?.id) invoiceIds.push(res.invoice.id);
  }},
  { weight: 3, name: "add note", run: async () => {
    if (!workOrderIds.length) return;
    await call("POST", `/api/v1/workorders/${pick(workOrderIds)}/notes`, {
      author: pick(CONSUMERS),
      body: "Replaced filter and tested airflow. Customer signed off.",
    });
  }},
  { weight: 2, name: "patch technician", run: async () => {
    if (!technicianIds.length) return;
    await call("PATCH", `/api/v1/technicians/${pick(technicianIds)}`, {
      region: pick(["north", "south", "east", "west"]),
    });
  }},
  { weight: 2, name: "create + delete customer", run: async () => {
    const created = await call("POST", "/api/v1/customers", {
      name: `Temp Customer ${Math.floor(Math.random() * 1000)}`,
      contactEmail: `temp${Math.floor(Math.random() * 1000)}@example.com`,
      tier: "free",
    });
    if (created?.id) await call("DELETE", `/api/v1/customers/${created.id}`);
  }},
  { weight: 2, name: "reserve part", run: async () => {
    if (!partIds.length) return;
    await call("POST", `/api/v1/parts/${pick(partIds)}/reserve`, { qty: 1 });
  }},
  { weight: 2, name: "pay invoice", run: async () => {
    if (!invoiceIds.length) return;
    const invoiceId = invoiceIds.pop()!;
    await call("POST", "/api/v1/payments", {
      invoiceId,
      amountCents: 12_500,
      method: pick(["card", "ach", "cash"]),
    }, "billing-cron");
  }},
  { weight: 2, name: "mobile sync", run: async () => {
    const ops = Array.from({ length: 5 + Math.floor(Math.random() * 30) }, () => ({
      workOrderId: workOrderIds.length ? pick(workOrderIds) : "wo_missing",
      kind: pick(["note", "status", "photo"]),
    }));
    await call("POST", "/api/v1/mobile/sync", { operations: ops });
  }},
  { weight: 2, name: "photo upload (fat body)", run: async () => {
    if (!workOrderIds.length) return;
    // ~200KB of base64 — enough for payload capture to be interesting.
    const dataBase64 = "A".repeat(200_000);
    await call("POST", "/api/v1/mobile/photos", {
      workOrderId: pick(workOrderIds),
      dataBase64,
    });
  }},

  // ── Auth, including failures ─────────────────────────────────────────────
  { weight: 3, name: "login ok", run: async () => {
    await call("POST", "/api/v1/auth/login", {
      email: "dispatcher@fieldops.example",
      password: "correct-horse",
    });
  }},
  { weight: 2, name: "login bad password", run: async () => {
    await call("POST", "/api/v1/auth/login", {
      email: "dispatcher@fieldops.example",
      password: "hunter2",
    });
  }},
  { weight: 1, name: "unauthorised /me", run: async () => {
    await call("GET", "/api/v1/auth/me");
  }},

  // ── Deliberate failures ──────────────────────────────────────────────────
  { weight: 3, name: "404 lookup", run: async () => {
    await call("GET", `/api/v1/workorders/wo_${crypto.randomUUID().slice(0, 8)}`);
  }},
  { weight: 2, name: "422 validation", run: async () => {
    await call("POST", "/api/v1/customers", { name: "Broken", contactEmail: "not-an-email" });
  }},
  { weight: 2, name: "insufficient stock (500)", run: async () => {
    if (!partIds.length) return;
    await call("POST", `/api/v1/parts/${pick(partIds)}/reserve`, { qty: 999_999 });
  }},
  { weight: 2, name: "server 500", run: async () => {
    await call("GET", `/api/v1/ops/boom?kind=${Math.floor(Math.random() * 4)}`);
  }},
  { weight: 2, name: "flaky 503", run: async () => {
    await call("GET", "/api/v1/ops/flaky?rate=0.5");
  }},
  { weight: 1, name: "slow request", run: async () => {
    await call("GET", `/api/v1/ops/slow?ms=${600 + Math.floor(Math.random() * 2400)}`);
  }},
  { weight: 1, name: "log storm", run: async () => {
    await call("POST", "/api/v1/ops/logstorm", { count: 40, label: "simulator" });
  }},
];

/** Flattened weight table — one entry per unit of weight. */
const WEIGHTED: Scenario[] = SCENARIOS.flatMap((s) => Array(s.weight).fill(s));

// ─── Driver ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
  FieldOps traffic simulator
  ────────────────────────────────────────────────────────
  target      ${BASE}
  duration    ${DURATION_S}s
  rate        ~${TARGET_RPS} req/s
  scenarios   ${SCENARIOS.length}
  consumers   ${CONSUMERS.length}
`);

  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`  Backend is not answering at ${BASE}.
  Start it first:  bun run examples/fieldops/backend/server.ts
`);
    process.exit(1);
  }

  await refresh();
  console.log(
    `  seeded refs  ${technicianIds.length} techs · ${customerIds.length} customers · ` +
      `${partIds.length} parts · ${workOrderIds.length} jobs\n`
  );

  const started = Date.now();
  const endAt = started + DURATION_S * 1000;
  const intervalMs = 1000 / TARGET_RPS;
  let lastReport = started;
  let lastRefresh = started;

  while (Date.now() < endAt) {
    const scenario = pick(WEIGHTED);
    // Fire and forget: waiting for the slow ones would throttle the whole run
    // to their latency, which is not the traffic shape we want.
    void scenario.run();

    await Bun.sleep(intervalMs);

    const now = Date.now();
    if (now - lastReport > 10_000) {
      report(started);
      lastReport = now;
    }
    // Pick up rows created since the run began.
    if (now - lastRefresh > 30_000) {
      void refresh();
      lastRefresh = now;
    }
  }

  // Let the last in-flight requests land, then let the plugin flush.
  await Bun.sleep(3_000);
  console.log("\n  final:");
  report(started);
  console.log(`
  Give the plugin a few seconds to flush, then open the dashboard.
`);
}

function report(started: number): void {
  const elapsed = (Date.now() - started) / 1000;
  const statuses = [...stat.byStatus.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, n]) => `${code}:${n}`)
    .join("  ");
  console.log(
    `  ${elapsed.toFixed(0).padStart(4)}s  sent=${stat.sent}  ` +
      `${(stat.sent / elapsed).toFixed(1)}/s  ${statuses}` +
      (stat.failed ? `  transport-failed=${stat.failed}` : "")
  );
}

main();
