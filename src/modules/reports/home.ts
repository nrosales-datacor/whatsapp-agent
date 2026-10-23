import type { Executor } from "../../platform/db/scope";
import { countRegisteredClients, listClientsAtRisk, type AtRiskClients } from "../clients";
import { getCollectedTotals } from "../sales";
import {
  addDays,
  APPOINTMENT_STATUSES,
  getAppointmentBreakdown,
  listAppointments,
  localDate,
  localDayBounds,
  type AppointmentStatus,
  type AppointmentView,
  type ConversationsWaitingCounter,
} from "../scheduling";
import { businessContextOf } from "./range";

// ─────────────────────────────────────────────────────────────────────────────
// Inicio completo del Pro (PLAN-GESTION.md §5): `GET /home/overview`. El Básico sigue con
// `GET /home/today` (scheduling); esto suma lo del negocio en números:
//
//   • cobrado hoy (neto, con señas y devoluciones), clientes nuevos hoy (altas), citas de
//     hoy por estado y no-show de hoy;
//   • alertas: citas sin confirmar de hoy (las que no empezaron) y de mañana, y clientes
//     en riesgo: el estado `at_risk` del CRM con las reglas del negocio (el mismo cálculo
//     que el chip y el filtro «En riesgo» de la lista de clientes, ver clients/stats.ts);
//   • ingresos (neto cobrado) de los últimos 14 días, día por día.
//
// "Hoy" es el día local de la sucursal elegida (o del negocio con "Todas"), igual que el
// Inicio básico. Las conversaciones esperando a una persona las cuenta WhatsApp: se
// inyecta el contador (reports no importa whatsapp); sin él, null.
// ─────────────────────────────────────────────────────────────────────────────

/** Días del gráfico de ingresos. */
export const REVENUE_DAYS = 14;
/** Citas sin confirmar que se listan (el conteo es completo). */
const UNCONFIRMED_LIMIT = 10;
/** Clientes en riesgo que se listan. */
const AT_RISK_LIMIT = 5;

export interface HomeOverview {
  date: string;
  timezone: string;
  locationId: string | null;
  currency: string;
  generatedAt: string;
  collectedToday: { collectedCents: number; refundsCents: number; netCents: number; count: number };
  /** Clientes registrados hoy (del negocio entero: el cliente no es de una sucursal). */
  newClientsToday: number;
  appointmentsToday: { total: number; byStatus: Record<AppointmentStatus, number> };
  noShowsToday: number;
  alerts: {
    unconfirmed: { today: number; tomorrow: number; items: AppointmentView[] };
    atRisk: AtRiskClients;
  };
  /** Neto cobrado por día, los últimos 14 días (hoy incluido), del más viejo al más nuevo. */
  revenue: { date: string; netCents: number }[];
  conversationsWaiting: number | null;
}

export async function getHomeOverview(
  db: Executor,
  businessId: string,
  options: {
    locationIds: readonly string[] | null;
    locationId: string | null;
    now?: Date;
    countConversationsWaiting?: ConversationsWaitingCounter;
  },
): Promise<HomeOverview> {
  const ctx = await businessContextOf(db, businessId);
  const now = options.now ?? new Date();
  const location = options.locationId ? ctx.locations.find((l) => l.id === options.locationId) : null;
  const timezone = location?.timezone ?? ctx.business.timezone;
  const date = localDate(now, timezone);
  const today = localDayBounds(date, timezone);
  const tomorrow = addDays(date, 1);
  const tomorrowEnd = localDayBounds(tomorrow, timezone).end;
  const { locationIds } = options;

  const appointmentsToday = await getAppointmentBreakdown(db, businessId, { from: today.start, to: today.end, locationIds });
  const collected = await getCollectedTotals(db, businessId, { from: today.start, to: today.end, locationIds });
  const newClientsToday = await countRegisteredClients(db, businessId, { from: today.start, to: today.end });

  // Sin confirmar: desde ahora (las de hoy que ya pasaron no se "confirman") hasta el fin de mañana.
  const pendingByDay = await getAppointmentBreakdown(db, businessId, { from: now, to: tomorrowEnd, locationIds, groupBy: "day", timeZone: timezone });
  const pendingOn = (day: string) => pendingByDay.groups.find((g) => g.key === day)?.byStatus.pending ?? 0;
  const unconfirmedItems = await listAppointments(db, businessId, { from: now, to: tomorrowEnd, locationIds, statuses: ["pending"], limit: UNCONFIRMED_LIMIT });

  const atRisk = await listClientsAtRisk(db, businessId, { now, limit: AT_RISK_LIMIT });

  const firstDay = addDays(date, -(REVENUE_DAYS - 1));
  const revenue = await getCollectedTotals(db, businessId, {
    from: localDayBounds(firstDay, timezone).start,
    to: today.end,
    locationIds,
    groupBy: "day",
    timeZone: timezone,
  });
  const netByDay = new Map(revenue.groups.map((g) => [g.key, g.netCents]));

  const byStatus = Object.fromEntries(APPOINTMENT_STATUSES.map((s) => [s, appointmentsToday.byStatus[s] ?? 0])) as Record<AppointmentStatus, number>;
  return {
    date,
    timezone,
    locationId: options.locationId,
    currency: ctx.business.currency,
    generatedAt: now.toISOString(),
    collectedToday: { collectedCents: collected.collectedCents, refundsCents: collected.refundsCents, netCents: collected.netCents, count: collected.count },
    newClientsToday,
    appointmentsToday: { total: appointmentsToday.total, byStatus },
    noShowsToday: byStatus.no_show,
    alerts: {
      unconfirmed: { today: pendingOn(date), tomorrow: pendingOn(tomorrow), items: unconfirmedItems },
      atRisk,
    },
    revenue: Array.from({ length: REVENUE_DAYS }, (_, i) => {
      const day = addDays(firstDay, i);
      return { date: day, netCents: netByDay.get(day) ?? 0 };
    }),
    conversationsWaiting: options.countConversationsWaiting ? await options.countConversationsWaiting(db, businessId, locationIds) : null,
  };
}
