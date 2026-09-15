// ─── FieldOps web console: the page ──────────────────────────────────────────
//
// Bundled by server.ts at boot and inlined into the page. Kept as its own file
// because it runs in a different place with different globals, and inlining it
// as a string would mean no typechecking on the part most likely to be wrong.

import { initSentrinelBrowser } from "@sentrinel/plugin/browser";

const sentrinel = initSentrinelBrowser({
  endpoint: "/api/sentrinel",
  release: "fieldops-web@2.4.0",
  // Short, so a click shows up in the dashboard while you are still looking.
  flushInterval: 3_000,
});

interface WorkOrder {
  id: string;
  title?: string;
  status: string;
  priority: string;
}

const jobs = document.getElementById("jobs")!;
const output = document.getElementById("log")!;
const lines: string[] = [];

function say(text: string): void {
  lines.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
  output.textContent = lines.slice(0, 12).join("\n");
}

/**
 * Every call is same-origin (/api/v1 is proxied to the backend), so the SDK
 * adds a traceparent: the backend continues this click's trace instead of
 * starting its own.
 */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.message ?? body.error ?? res.statusText}`);
  return body as T;
}

function row(wo: WorkOrder): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${wo.title ?? wo.id}<br><small style="opacity:.6">${wo.id}</small></td>
    <td><span class="pill">${wo.status}</span></td>
    <td>${wo.priority}</td>
    <td class="actions"></td>`;
  const actions = tr.querySelector("td.actions")!;

  const start = document.createElement("button");
  start.textContent = "Start";
  start.disabled = wo.status !== "scheduled";
  start.onclick = () => act(`start ${wo.id}`, () => api(`/workorders/${wo.id}/start`, { method: "POST" }));

  const complete = document.createElement("button");
  complete.textContent = "Complete";
  complete.className = "primary";
  complete.disabled = wo.status === "completed";
  complete.onclick = () =>
    act(`complete ${wo.id}`, () =>
      api(`/workorders/${wo.id}/complete`, { method: "POST", body: JSON.stringify({ partsUsed: [] }) })
    );

  actions.append(start, " ", complete);
  return tr;
}

async function act(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    say(`${label}: ok`);
  } catch (err) {
    say(`${label}: ${(err as Error).message}`);
  }
  await refresh();
}

async function refresh(): Promise<void> {
  try {
    const [scheduled, active] = await Promise.all([
      api<{ workOrders: WorkOrder[] }>("/workorders?status=scheduled"),
      api<{ workOrders: WorkOrder[] }>("/workorders?status=in_progress"),
    ]);
    const list = [...active.workOrders, ...scheduled.workOrders].slice(0, 12);
    jobs.replaceChildren(...list.map(row));
    if (!list.length) jobs.innerHTML = `<tr><td colspan="4">No open jobs.</td></tr>`;
  } catch (err) {
    jobs.innerHTML = `<tr><td colspan="4">${(err as Error).message}</td></tr>`;
    // Reported, not just shown: a console that cannot load its jobs is broken
    // for every dispatcher looking at it.
    sentrinel.captureError(err as Error, { view: "jobs" });
  }
}

document.getElementById("refresh")!.onclick = () => void refresh();

document.getElementById("summary")!.onclick = () =>
  act("dashboard summary", () => api("/analytics/summary"));

document.getElementById("conflict")!.onclick = async () => {
  // Completing a job that is already done is a 409 from the backend: a client
  // error, recorded on both sides of the same trace.
  const { workOrders } = await api<{ workOrders: WorkOrder[] }>("/workorders?status=completed");
  const done = workOrders[0];
  if (!done) return say("no completed job to try that on yet");
  await act(`complete ${done.id} again`, () =>
    api(`/workorders/${done.id}/complete`, { method: "POST", body: JSON.stringify({ partsUsed: [] }) })
  );
};

document.getElementById("crash")!.onclick = () => {
  say("throwing — reported as an issue with this session's replay");
  setTimeout(() => {
    throw new TypeError("cannot read properties of undefined (reading 'technician')");
  });
};

void refresh();
