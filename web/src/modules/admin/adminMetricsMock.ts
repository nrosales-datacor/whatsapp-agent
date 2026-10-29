import type { AdminBusiness } from "../../lib/contract";
import type { Activation, BusinessUsage, BusinessUsageRow, PlatformMetrics, UsageRange, UsageTotals } from "./adminApi";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de producto del superadmin en la API simulada (I5): mismas formas que
// src/admin/metrics.ts, con uso diario FICTICIO y estable (sale del id del negocio y del
// día, sin azar): los negocios recién creados en el mock no tienen actividad.
// ─────────────────────────────────────────────────────────────────────────────

const KEYS: (keyof UsageTotals)[] = ["appointmentsCreated", "paymentsRecorded", "activeUsers", "logins", "aiConversations", "whatsappHandoffs"];
const zero = (): UsageTotals => ({ appointmentsCreated: 0, paymentsRecorded: 0, activeUsers: 0, logins: 0, aiConversations: 0, whatsappHandoffs: 0 });

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayCR(): string {
  return new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
}

/** Entero estable de 0 a 2^31 a partir de un texto. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Uso de un negocio en un día (0 si no estaba activo o es un negocio sin datos semilla). */
function usageOn(business: AdminBusiness, date: string, seeded: boolean): UsageTotals {
  if (!seeded || business.status !== "active" || date < business.createdAt.slice(0, 10)) return zero();
  const h = hash(`${business.id}:${date}`);
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const scale = weekend ? 0.4 : 1;
  const agent = business.modules.includes("whatsapp");
  return {
    appointmentsCreated: Math.round(((h % 9) + 2) * scale),
    paymentsRecorded: business.modules.includes("sales") ? Math.round(((h >> 4) % 7) * scale) : 0,
    activeUsers: 1 + ((h >> 8) % 3),
    logins: (h >> 10) % 3,
    aiConversations: agent ? Math.round(((h >> 12) % 12) * scale) : 0,
    whatsappHandoffs: agent ? (h >> 16) % 2 : 0,
  };
}

export function resolveMockRange(params: URLSearchParams): UsageRange | { error: string } {
  const to = params.get("to") ?? todayCR();
  const from = params.get("from") ?? addDays(to, -29);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "Fecha inválida (formato AAAA-MM-DD)." };
  if (from > to) return { error: "El fin tiene que ser igual o posterior al inicio." };
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (++days > 366) return { error: "El rango puede ser de a lo sumo 366 días." };
  return { from, to, days, timezone: "America/Costa_Rica" };
}

function datesOf(range: UsageRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

function activationOf(business: AdminBusiness, seeded: boolean): Activation {
  const first = seeded ? addDays(business.createdAt.slice(0, 10), 1) : null;
  return {
    firstLoginOn: first,
    firstAppointmentOn: first,
    firstPaymentOn: seeded && business.modules.includes("sales") ? first : null,
    firstAiConversationOn: seeded && business.modules.includes("whatsapp") ? first : null,
    activated: seeded,
  };
}

export function mockPlatformMetrics(businesses: AdminBusiness[], seededIds: ReadonlySet<string>, range: UsageRange): PlatformMetrics {
  const dates = datesOf(range);
  const weekFrom = addDays(range.to, -6);
  const rows: BusinessUsageRow[] = businesses.map((b) => {
    const seeded = seededIds.has(b.id);
    const usage = zero();
    let activeDays = 0;
    let last: string | null = null;
    let lastWeek = 0;
    for (const date of dates) {
      const u = usageOn(b, date, seeded);
      for (const k of KEYS) usage[k] += u[k];
      if (u.activeUsers > 0) activeDays += 1;
      if (KEYS.some((k) => u[k] > 0)) last = date;
    }
    for (let d = weekFrom; d <= range.to; d = addDays(d, 1)) lastWeek += usageOn(b, d, seeded).appointmentsCreated;
    return {
      id: b.id,
      name: b.name,
      planLabel: b.planLabel,
      status: b.status,
      createdAt: b.createdAt,
      agentOn: seeded && b.status === "active" && b.modules.includes("whatsapp") && b.planLabel !== "Pro sin agente",
      usage,
      appointmentsLastWeek: lastWeek,
      activeDays,
      lastActivityOn: last,
      activation: activationOf(b, seeded),
    };
  });
  rows.sort((a, b) => Number(Boolean(b.lastActivityOn)) - Number(Boolean(a.lastActivityOn)) || b.usage.appointmentsCreated - a.usage.appointmentsCreated || b.createdAt.localeCompare(a.createdAt));
  const totals = zero();
  for (const r of rows) for (const k of KEYS) totals[k] += r.usage[k];
  return {
    range,
    totals: {
      ...totals,
      businesses: rows.length,
      activeBusinesses: rows.filter((r) => r.status === "active").length,
      pausedBusinesses: rows.filter((r) => r.status === "paused").length,
      withActivity: rows.filter((r) => r.lastActivityOn).length,
      withAppointmentsLastWeek: rows.filter((r) => r.appointmentsLastWeek > 0).length,
      withAgentOn: rows.filter((r) => r.agentOn).length,
      activated: rows.filter((r) => r.activation.activated).length,
    },
    daily: dates.map((date) => {
      const day = zero();
      let active = 0;
      for (const b of businesses) {
        const u = usageOn(b, date, seededIds.has(b.id));
        for (const k of KEYS) day[k] += u[k];
        if (KEYS.some((k) => u[k] > 0)) active += 1;
      }
      return { date, ...day, activeBusinesses: active };
    }),
    businesses: rows,
  };
}

export function mockBusinessUsage(business: AdminBusiness, seeded: boolean, range: UsageRange): BusinessUsage {
  const totals = zero();
  const daily = datesOf(range).map((date) => {
    const u = usageOn(business, date, seeded);
    for (const k of KEYS) totals[k] += u[k];
    return { date, ...u };
  });
  return {
    business: { id: business.id, name: business.name, planLabel: business.planLabel, status: business.status },
    range,
    totals,
    daily,
    activation: activationOf(business, seeded),
  };
}
