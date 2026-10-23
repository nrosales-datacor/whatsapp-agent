import { z } from "zod";
import type { Executor } from "../platform/db/scope";
import { HttpError, ValidationError } from "../platform/http/errors";
import {
  activeBusinessesByDay,
  dailyUsageSeries,
  firstUsageDates,
  summarizeDailyUsage,
  USAGE_METRICS,
  type UsageSummaryRow,
} from "../platform/observability/dailyUsage";
import { listAdminBusinesses, resolveEntitlements } from "../modules/billing";
import { getBusinessRow } from "../modules/business";
import { addDays, isLocalDate, localDate } from "../modules/scheduling";
import { listConnectedWhatsAppBusinessIds } from "../modules/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de producto del superadmin (I5, PLAN-GESTION.md §2 "Medible"): activación y
// uso por negocio a partir de `daily_usage` (citas creadas, pagos registrados, usuarios
// activos, logins, conversaciones del agente, traspasos a una persona).
//
//   GET /admin/metrics?from&to               toda la plataforma + una fila por negocio
//   GET /admin/businesses/:id/usage?from&to  la serie diaria de un negocio
//
// Días locales "AAAA-MM-DD" (inclusive). `daily_usage` guarda el día local de CADA negocio;
// el rango por defecto (últimos 30 días) se calcula en la zona de la plataforma (Costa Rica).
//
// Definiciones:
//   • Activo: el negocio no está pausado ni dado de baja (`status = active`).
//   • Con actividad: alguna métrica > 0 en el rango.
//   • Con citas en la última semana: citas creadas en los 7 días que terminan en `to`.
//   • Agente encendido: activo, el plan incluye WhatsApp IA y tiene un número conectado.
//   • Activado (hito, de toda la historia): ya entró alguien al panel Y creó una cita.
// ─────────────────────────────────────────────────────────────────────────────

/** Zona de la plataforma para el rango por defecto del superadmin. */
export const PLATFORM_TIMEZONE = "America/Costa_Rica";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

const METRICS = USAGE_METRICS;
type MetricKey = keyof typeof METRICS;
const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
const METRIC_NAMES: readonly string[] = Object.values(METRICS);

const LocalDate = z.string().refine(isLocalDate, "Fecha inválida (formato AAAA-MM-DD).");
export const UsageRangeQuery = z.object({ from: LocalDate.optional(), to: LocalDate.optional() });

export interface UsageRange {
  from: string;
  to: string;
  days: number;
  timezone: string;
}

/** Totales de las métricas (`activeUsers` = días-persona: una persona activa 3 días suma 3). */
export type UsageTotals = Record<MetricKey, number>;

export interface Activation {
  firstLoginOn: string | null;
  firstAppointmentOn: string | null;
  firstPaymentOn: string | null;
  firstAiConversationOn: string | null;
  /** Entró alguien al panel y creó una cita (alguna vez). */
  activated: boolean;
}

export interface BusinessUsageRow {
  id: string;
  name: string;
  planLabel: string;
  status: string;
  createdAt: string;
  agentOn: boolean;
  usage: UsageTotals;
  appointmentsLastWeek: number;
  /** Días con alguien usando el panel. */
  activeDays: number;
  /** Último día con alguna métrica > 0 en el rango. */
  lastActivityOn: string | null;
  activation: Activation;
}

export interface PlatformMetrics {
  range: UsageRange;
  totals: UsageTotals & {
    businesses: number;
    activeBusinesses: number;
    pausedBusinesses: number;
    withActivity: number;
    withAppointmentsLastWeek: number;
    withAgentOn: number;
    activated: number;
  };
  /** Todos los días del rango: uso de toda la plataforma y negocios con actividad ese día. */
  daily: (UsageTotals & { date: string; activeBusinesses: number })[];
  /** Con actividad primero (por citas creadas), después el resto por alta. */
  businesses: BusinessUsageRow[];
}

export interface BusinessUsage {
  business: { id: string; name: string; planLabel: string; status: string };
  range: UsageRange;
  totals: UsageTotals;
  daily: (UsageTotals & { date: string })[];
  activation: Activation;
}

const zeroTotals = (): UsageTotals => Object.fromEntries(METRIC_KEYS.map((k) => [k, 0])) as UsageTotals;
const keyOfMetric = new Map(METRIC_KEYS.map((k) => [METRICS[k] as string, k]));

/** Rango del superadmin: días inclusive, default los últimos 30 hasta hoy. */
export function resolveUsageRange(query: z.output<typeof UsageRangeQuery>, now: Date = new Date()): UsageRange {
  const to = query.to ?? localDate(now, PLATFORM_TIMEZONE);
  const from = query.from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) throw new ValidationError({ "query.to": "El fin tiene que ser igual o posterior al inicio." });
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (++days > MAX_DAYS) throw new ValidationError({ "query.to": `El rango puede ser de a lo sumo ${MAX_DAYS} días.` });
  }
  return { from, to, days, timezone: PLATFORM_TIMEZONE };
}

function datesOf(range: UsageRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

function activationOf(firsts: Map<string, string>): Activation {
  const firstLoginOn = firsts.get(METRICS.logins) ?? firsts.get(METRICS.activeUsers) ?? null;
  const firstAppointmentOn = firsts.get(METRICS.appointmentsCreated) ?? null;
  return {
    firstLoginOn,
    firstAppointmentOn,
    firstPaymentOn: firsts.get(METRICS.paymentsRecorded) ?? null,
    firstAiConversationOn: firsts.get(METRICS.aiConversations) ?? null,
    activated: Boolean(firstLoginOn && firstAppointmentOn),
  };
}

function groupByBusiness<T extends { businessId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.businessId);
    if (list) list.push(r);
    else out.set(r.businessId, [r]);
  }
  return out;
}

/** `GET /admin/metrics`: activación y uso de toda la plataforma y de cada negocio. */
export async function getPlatformMetrics(db: Executor, range: UsageRange): Promise<PlatformMetrics> {
  const weekFrom = addDays(range.to, -6);
  const [businesses, summary, lastWeek, series, activeByDay, firsts, connected] = await Promise.all([
    listAdminBusinesses(db),
    summarizeDailyUsage(db, { from: range.from, to: range.to, metrics: METRIC_NAMES }),
    summarizeDailyUsage(db, { from: weekFrom, to: range.to, metrics: [METRICS.appointmentsCreated] }),
    dailyUsageSeries(db, { from: range.from, to: range.to, metrics: METRIC_NAMES }),
    activeBusinessesByDay(db, { from: range.from, to: range.to, metrics: METRIC_NAMES }),
    firstUsageDates(db, { metrics: METRIC_NAMES }),
    listConnectedWhatsAppBusinessIds(db),
  ]);
  const summaryBy = groupByBusiness<UsageSummaryRow>(summary);
  const lastWeekBy = new Map(lastWeek.map((r) => [r.businessId, r.total]));
  const firstsBy = groupByBusiness(firsts);

  const rows: BusinessUsageRow[] = businesses.map((b) => {
    const usage = zeroTotals();
    let lastActivityOn: string | null = null;
    let activeDays = 0;
    for (const r of summaryBy.get(b.id) ?? []) {
      const key = keyOfMetric.get(r.metric);
      if (!key) continue;
      usage[key] = r.total;
      if (r.metric === METRICS.activeUsers) activeDays = r.activeDays;
      if (r.lastDate && (!lastActivityOn || r.lastDate > lastActivityOn)) lastActivityOn = r.lastDate;
    }
    const agentOn = b.status === "active" && b.modules.includes("whatsapp") && connected.has(b.id);
    return {
      id: b.id,
      name: b.name,
      planLabel: b.planLabel,
      status: b.status,
      createdAt: b.createdAt,
      agentOn,
      usage,
      appointmentsLastWeek: lastWeekBy.get(b.id) ?? 0,
      activeDays,
      lastActivityOn,
      activation: activationOf(new Map((firstsBy.get(b.id) ?? []).map((f) => [f.metric, f.firstDate]))),
    };
  });
  rows.sort(
    (a, b) =>
      Number(Boolean(b.lastActivityOn)) - Number(Boolean(a.lastActivityOn)) ||
      b.usage.appointmentsCreated - a.usage.appointmentsCreated ||
      b.createdAt.localeCompare(a.createdAt),
  );

  const totals = zeroTotals();
  for (const r of rows) for (const k of METRIC_KEYS) totals[k] += r.usage[k];
  const seriesBy = new Map<string, UsageTotals>();
  for (const s of series) {
    const key = keyOfMetric.get(s.metric);
    if (!key) continue;
    const day = seriesBy.get(s.date) ?? zeroTotals();
    day[key] = s.total;
    seriesBy.set(s.date, day);
  }
  const activeBy = new Map(activeByDay.map((d) => [d.date, d.businesses]));

  return {
    range,
    totals: {
      ...totals,
      businesses: rows.length,
      activeBusinesses: rows.filter((r) => r.status === "active").length,
      pausedBusinesses: rows.filter((r) => r.status === "paused").length,
      withActivity: rows.filter((r) => r.lastActivityOn !== null).length,
      withAppointmentsLastWeek: rows.filter((r) => r.appointmentsLastWeek > 0).length,
      withAgentOn: rows.filter((r) => r.agentOn).length,
      activated: rows.filter((r) => r.activation.activated).length,
    },
    daily: datesOf(range).map((date) => ({ date, ...(seriesBy.get(date) ?? zeroTotals()), activeBusinesses: activeBy.get(date) ?? 0 })),
    businesses: rows,
  };
}

/** `GET /admin/businesses/:id/usage`: la serie diaria de un negocio (404 si no existe). */
export async function getBusinessUsage(db: Executor, businessId: string, range: UsageRange): Promise<BusinessUsage> {
  const business = await getBusinessRow(db, businessId);
  if (!business) throw new HttpError(404, "Ese negocio no existe.", "not_found");
  const [series, firsts] = await Promise.all([
    dailyUsageSeries(db, { from: range.from, to: range.to, metrics: METRIC_NAMES, businessId }),
    firstUsageDates(db, { metrics: METRIC_NAMES, businessId }),
  ]);
  const byDay = new Map<string, UsageTotals>();
  const totals = zeroTotals();
  for (const s of series) {
    const key = keyOfMetric.get(s.metric);
    if (!key) continue;
    const day = byDay.get(s.date) ?? zeroTotals();
    day[key] = s.total;
    byDay.set(s.date, day);
    totals[key] += s.total;
  }
  return {
    business: { id: business.id, name: business.name, planLabel: resolveEntitlements(business).label, status: business.status },
    range,
    totals,
    daily: datesOf(range).map((date) => ({ date, ...(byDay.get(date) ?? zeroTotals()) })),
    activation: activationOf(new Map(firsts.map((f) => [f.metric, f.firstDate]))),
  };
}
