// ─── FieldOps in-memory store ────────────────────────────────────────────────
//
// Stands in for a database. Every method sleeps for a plausible amount of time
// so the performance pages have a distribution to draw rather than a flat line
// at 0ms, and a few of them fail on purpose so Issues has something to group.
//
// The whole object is passed through `traceObject`, so each call becomes a
// child span named `db.<method>` without a decorator on any of them.

import { traceObject, tspan } from "@sentrinel/plugin";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Technician {
  id: string;
  name: string;
  email: string;
  skills: string[];
  region: string;
  active: boolean;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  tier: "free" | "pro" | "enterprise";
  contactEmail: string;
  phone: string;
  createdAt: string;
}

export interface Site {
  id: string;
  customerId: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
}

export type WorkOrderStatus = "draft" | "scheduled" | "in_progress" | "completed" | "cancelled";

export interface WorkOrder {
  id: string;
  customerId: string;
  siteId: string;
  technicianId: string | null;
  title: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: WorkOrderStatus;
  partsUsed: { partId: string; qty: number }[];
  notes: { at: string; author: string; body: string }[];
  scheduledFor: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Part {
  id: string;
  sku: string;
  name: string;
  onHand: number;
  reserved: number;
  unitPriceCents: number;
}

export interface Invoice {
  id: string;
  customerId: string;
  workOrderId: string;
  amountCents: number;
  status: "draft" | "sent" | "paid" | "void";
  sentAt: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: "card" | "ach" | "cash";
  status: "pending" | "settled" | "failed";
  createdAt: string;
}

// ─── Seed data ───────────────────────────────────────────────────────────────

const REGIONS = ["north", "south", "east", "west"];
const SKILLS = ["hvac", "electrical", "plumbing", "network", "solar"];
const TIERS: Customer["tier"][] = ["free", "pro", "enterprise"];

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Deterministic-ish jitter around a target latency. */
function latency(target: number, spread = 0.4): number {
  const delta = target * spread;
  return Math.max(1, Math.round(target - delta + Math.random() * delta * 2));
}

async function sleep(target: number, spread?: number): Promise<void> {
  await Bun.sleep(latency(target, spread));
}

class FieldOpsStore {
  technicians = new Map<string, Technician>();
  customers = new Map<string, Customer>();
  sites = new Map<string, Site>();
  workOrders = new Map<string, WorkOrder>();
  parts = new Map<string, Part>();
  invoices = new Map<string, Invoice>();
  payments = new Map<string, Payment>();

  seed(): void {
    for (let i = 0; i < 24; i++) {
      const t: Technician = {
        id: id("tech"),
        name: `Technician ${i + 1}`,
        email: `tech${i + 1}@fieldops.example`,
        skills: [pick(SKILLS), pick(SKILLS)],
        region: pick(REGIONS),
        active: Math.random() > 0.15,
        createdAt: new Date().toISOString(),
      };
      this.technicians.set(t.id, t);
    }

    for (let i = 0; i < 40; i++) {
      const c: Customer = {
        id: id("cust"),
        name: `Customer ${i + 1}`,
        tier: pick(TIERS),
        contactEmail: `ops${i + 1}@customer.example`,
        phone: `+15550${String(1000 + i)}`,
        createdAt: new Date().toISOString(),
      };
      this.customers.set(c.id, c);

      const siteCount = 1 + Math.floor(Math.random() * 3);
      for (let s = 0; s < siteCount; s++) {
        const site: Site = {
          id: id("site"),
          customerId: c.id,
          label: `Site ${s + 1}`,
          address: `${100 + s} Example Ave`,
          lat: 37 + Math.random(),
          lng: -122 + Math.random(),
        };
        this.sites.set(site.id, site);
      }
    }

    for (let i = 0; i < 30; i++) {
      const p: Part = {
        id: id("part"),
        sku: `SKU-${1000 + i}`,
        name: `Part ${i + 1}`,
        onHand: Math.floor(Math.random() * 80),
        reserved: 0,
        unitPriceCents: 500 + Math.floor(Math.random() * 40_000),
      };
      this.parts.set(p.id, p);
    }

    const customerIds = [...this.customers.keys()];
    const techIds = [...this.technicians.keys()];
    for (let i = 0; i < 60; i++) {
      const customerId = pick(customerIds);
      const siteList = [...this.sites.values()].filter((s) => s.customerId === customerId);
      const wo: WorkOrder = {
        id: id("wo"),
        customerId,
        siteId: siteList[0]?.id ?? "",
        technicianId: Math.random() > 0.3 ? pick(techIds) : null,
        title: `Job ${i + 1}`,
        priority: pick(["low", "normal", "high", "urgent"] as const),
        status: pick(["draft", "scheduled", "in_progress", "completed"] as const),
        partsUsed: [],
        notes: [],
        scheduledFor: new Date(Date.now() + Math.random() * 6e8).toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.workOrders.set(wo.id, wo);
    }
  }

  // ── Technicians ────────────────────────────────────────────────────────────

  async listTechnicians(filter: { region?: string; active?: boolean }): Promise<Technician[]> {
    await sleep(14);
    let rows = [...this.technicians.values()];
    if (filter.region) rows = rows.filter((t) => t.region === filter.region);
    if (filter.active !== undefined) rows = rows.filter((t) => t.active === filter.active);
    return rows;
  }

  async getTechnician(techId: string): Promise<Technician | null> {
    await sleep(6);
    return this.technicians.get(techId) ?? null;
  }

  async createTechnician(input: Omit<Technician, "id" | "createdAt">): Promise<Technician> {
    await sleep(22);
    const t: Technician = { ...input, id: id("tech"), createdAt: new Date().toISOString() };
    this.technicians.set(t.id, t);
    return t;
  }

  async updateTechnician(techId: string, patch: Partial<Technician>): Promise<Technician | null> {
    await sleep(18);
    const existing = this.technicians.get(techId);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id };
    this.technicians.set(techId, next);
    return next;
  }

  async deleteTechnician(techId: string): Promise<boolean> {
    await sleep(12);
    return this.technicians.delete(techId);
  }

  /** Deliberately heavy: joins across three collections, no index. */
  async technicianSchedule(techId: string): Promise<WorkOrder[]> {
    return tspan("db.technicianSchedule", async ({ setAttribute }) => {
      await sleep(45, 0.7);
      const rows = [...this.workOrders.values()].filter((w) => w.technicianId === techId);
      setAttribute("schedule.jobs", rows.length);
      return rows;
    });
  }

  // ── Customers ──────────────────────────────────────────────────────────────

  async listCustomers(filter: { tier?: string; q?: string }): Promise<Customer[]> {
    await sleep(16);
    let rows = [...this.customers.values()];
    if (filter.tier) rows = rows.filter((c) => c.tier === filter.tier);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      rows = rows.filter((c) => c.name.toLowerCase().includes(q));
    }
    return rows;
  }

  async getCustomer(customerId: string): Promise<Customer | null> {
    await sleep(7);
    return this.customers.get(customerId) ?? null;
  }

  async createCustomer(input: Omit<Customer, "id" | "createdAt">): Promise<Customer> {
    await sleep(24);
    const c: Customer = { ...input, id: id("cust"), createdAt: new Date().toISOString() };
    this.customers.set(c.id, c);
    return c;
  }

  async updateCustomer(customerId: string, patch: Partial<Customer>): Promise<Customer | null> {
    await sleep(19);
    const existing = this.customers.get(customerId);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id };
    this.customers.set(customerId, next);
    return next;
  }

  async deleteCustomer(customerId: string): Promise<boolean> {
    await sleep(15);
    return this.customers.delete(customerId);
  }

  async sitesForCustomer(customerId: string): Promise<Site[]> {
    await sleep(11);
    return [...this.sites.values()].filter((s) => s.customerId === customerId);
  }

  // ── Work orders ────────────────────────────────────────────────────────────

  async listWorkOrders(filter: {
    status?: string;
    technicianId?: string;
    customerId?: string;
  }): Promise<WorkOrder[]> {
    await sleep(26);
    let rows = [...this.workOrders.values()];
    if (filter.status) rows = rows.filter((w) => w.status === filter.status);
    if (filter.technicianId) rows = rows.filter((w) => w.technicianId === filter.technicianId);
    if (filter.customerId) rows = rows.filter((w) => w.customerId === filter.customerId);
    return rows;
  }

  async getWorkOrder(woId: string): Promise<WorkOrder | null> {
    await sleep(8);
    return this.workOrders.get(woId) ?? null;
  }

  async createWorkOrder(input: {
    customerId: string;
    siteId: string;
    title: string;
    priority: WorkOrder["priority"];
  }): Promise<WorkOrder> {
    await sleep(30);
    const wo: WorkOrder = {
      id: id("wo"),
      customerId: input.customerId,
      siteId: input.siteId,
      technicianId: null,
      title: input.title,
      priority: input.priority,
      status: "draft",
      partsUsed: [],
      notes: [],
      scheduledFor: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.workOrders.set(wo.id, wo);
    return wo;
  }

  async updateWorkOrder(woId: string, patch: Partial<WorkOrder>): Promise<WorkOrder | null> {
    await sleep(21);
    const existing = this.workOrders.get(woId);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id };
    this.workOrders.set(woId, next);
    return next;
  }

  async deleteWorkOrder(woId: string): Promise<boolean> {
    await sleep(13);
    return this.workOrders.delete(woId);
  }

  // ── Inventory ──────────────────────────────────────────────────────────────

  async listParts(filter: { lowStock?: boolean }): Promise<Part[]> {
    await sleep(17);
    let rows = [...this.parts.values()];
    if (filter.lowStock) rows = rows.filter((p) => p.onHand - p.reserved < 10);
    return rows;
  }

  async getPart(partId: string): Promise<Part | null> {
    await sleep(6);
    return this.parts.get(partId) ?? null;
  }

  async createPart(input: Omit<Part, "id" | "reserved">): Promise<Part> {
    await sleep(20);
    const p: Part = { ...input, id: id("part"), reserved: 0 };
    this.parts.set(p.id, p);
    return p;
  }

  async updatePart(partId: string, patch: Partial<Part>): Promise<Part | null> {
    await sleep(16);
    const existing = this.parts.get(partId);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id };
    this.parts.set(partId, next);
    return next;
  }

  async deletePart(partId: string): Promise<boolean> {
    await sleep(10);
    return this.parts.delete(partId);
  }

  /**
   * Reserving stock is where this store bites back: it throws when the part is
   * short, which is exactly the kind of domain error worth seeing grouped in
   * Issues rather than buried in a log line.
   */
  async reservePart(partId: string, qty: number): Promise<Part> {
    return tspan("db.reservePart", async ({ setAttribute }) => {
      await sleep(28);
      const part = this.parts.get(partId);
      if (!part) throw new Error(`PartNotFound: ${partId}`);

      const available = part.onHand - part.reserved;
      setAttribute("part.sku", part.sku);
      setAttribute("part.available", available);
      setAttribute("part.requested", qty);

      if (qty > available) {
        throw new Error(
          `InsufficientStock: ${part.sku} has ${available} available, ${qty} requested`
        );
      }
      part.reserved += qty;
      return part;
    });
  }

  // ── Billing ────────────────────────────────────────────────────────────────

  async listInvoices(filter: { status?: string; customerId?: string }): Promise<Invoice[]> {
    await sleep(23);
    let rows = [...this.invoices.values()];
    if (filter.status) rows = rows.filter((i) => i.status === filter.status);
    if (filter.customerId) rows = rows.filter((i) => i.customerId === filter.customerId);
    return rows;
  }

  async getInvoice(invoiceId: string): Promise<Invoice | null> {
    await sleep(9);
    return this.invoices.get(invoiceId) ?? null;
  }

  async createInvoice(input: Omit<Invoice, "id" | "createdAt" | "sentAt">): Promise<Invoice> {
    await sleep(34);
    const inv: Invoice = {
      ...input,
      id: id("inv"),
      sentAt: null,
      createdAt: new Date().toISOString(),
    };
    this.invoices.set(inv.id, inv);
    return inv;
  }

  async updateInvoice(invoiceId: string, patch: Partial<Invoice>): Promise<Invoice | null> {
    await sleep(18);
    const existing = this.invoices.get(invoiceId);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id };
    this.invoices.set(invoiceId, next);
    return next;
  }

  async createPayment(input: Omit<Payment, "id" | "createdAt">): Promise<Payment> {
    await sleep(40, 0.8);
    const p: Payment = { ...input, id: id("pay"), createdAt: new Date().toISOString() };
    this.payments.set(p.id, p);
    return p;
  }

  async getPayment(paymentId: string): Promise<Payment | null> {
    await sleep(8);
    return this.payments.get(paymentId) ?? null;
  }

  // ── Analytics — the slow, scan-everything queries ──────────────────────────

  async revenueByMonth(): Promise<{ month: string; cents: number }[]> {
    return tspan("db.revenueByMonth", async ({ setAttribute }) => {
      await sleep(140, 0.6);
      const buckets = new Map<string, number>();
      for (const inv of this.invoices.values()) {
        if (inv.status !== "paid") continue;
        const month = inv.createdAt.slice(0, 7);
        buckets.set(month, (buckets.get(month) ?? 0) + inv.amountCents);
      }
      setAttribute("rows.scanned", this.invoices.size);
      return [...buckets.entries()].map(([month, cents]) => ({ month, cents }));
    });
  }

  async technicianUtilization(): Promise<{ technicianId: string; jobs: number }[]> {
    return tspan("db.technicianUtilization", async ({ setAttribute }) => {
      await sleep(110, 0.6);
      const counts = new Map<string, number>();
      for (const wo of this.workOrders.values()) {
        if (!wo.technicianId) continue;
        counts.set(wo.technicianId, (counts.get(wo.technicianId) ?? 0) + 1);
      }
      setAttribute("rows.scanned", this.workOrders.size);
      return [...counts.entries()].map(([technicianId, jobs]) => ({ technicianId, jobs }));
    });
  }

  async search(q: string): Promise<{ kind: string; id: string; label: string }[]> {
    return tspan("db.search", async ({ setAttribute }) => {
      // A full scan across every collection — the classic endpoint that is fine
      // in staging and falls over in production.
      await sleep(75, 0.9);
      const needle = q.toLowerCase();
      const out: { kind: string; id: string; label: string }[] = [];
      for (const c of this.customers.values()) {
        if (c.name.toLowerCase().includes(needle)) out.push({ kind: "customer", id: c.id, label: c.name });
      }
      for (const t of this.technicians.values()) {
        if (t.name.toLowerCase().includes(needle)) out.push({ kind: "technician", id: t.id, label: t.name });
      }
      for (const w of this.workOrders.values()) {
        if (w.title.toLowerCase().includes(needle)) out.push({ kind: "workorder", id: w.id, label: w.title });
      }
      setAttribute("search.hits", out.length);
      return out;
    });
  }
}

const raw = new FieldOpsStore();
raw.seed();

/** Every method call becomes a `db.*` child span. */
export const store = traceObject(raw, "db");

/** Unwrapped handle, for seeding and assertions that should not emit spans. */
export const rawStore = raw;
