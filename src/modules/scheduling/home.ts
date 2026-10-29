import { and, count, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { getBusinessContext } from "../business";
import { getAppointmentsByIds, listAppointments, type AppointmentView } from "./appointments";
import { ACTIVE_APPOINTMENT_STATUSES, APPOINTMENT_STATUSES, appointments, type AppointmentStatus } from "./schema";
import { addDays, DAY_MS, localDate, localDayBounds, mondayOf } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Inicio básico (PLAN-GESTION.md §5): el día de la sucursal activa (o de todas) en una
// sola respuesta. "Hoy" y "esta semana" se cuentan en la zona horaria de la sucursal (o
// la del negocio con "Todas"). El Inicio completo del Pro (cobrado hoy, clientes nuevos,
// en riesgo, ingresos) llega en I5. Las conversaciones esperando a una persona las cuenta
// el módulo de WhatsApp: el núcleo no lo importa, se le inyecta `countConversationsWaiting`
// (src/routes.ts); sin él, `conversationsWaiting` queda en null.
// ─────────────────────────────────────────────────────────────────────────────

/** Cuenta las conversaciones esperando a una persona (null = sucursales que ve la sesión: todas). */
export type ConversationsWaitingCounter = (
  executor: Executor,
  businessId: string,
  locationIds: readonly string[] | null,
) => Promise<number>;

/** Cuántas próximas citas muestra la tarjeta. */
const UPCOMING_LIMIT = 6;
/** Cuántas citas del agente se listan (el conteo es completo). */
const AI_RECENT_LIMIT = 5;

export interface HomeToday {
  /** Día local de "hoy" ("AAAA-MM-DD") y su zona. */
  date: string;
  timezone: string;
  /** Sucursal del resumen (null = todas las que ve la sesión). */
  locationId: string | null;
  generatedAt: string;
  /** Citas que empiezan hoy, por estado. */
  today: { total: number; byStatus: Record<AppointmentStatus, number> };
  /** Próximas citas vivas desde ahora (hasta 7 días). */
  upcoming: AppointmentView[];
  /** Sin confirmar de hoy (las que todavía no empezaron) y de mañana. */
  unconfirmed: AppointmentView[];
  /** Marcadas como no asistió, de hoy. */
  noShowsToday: AppointmentView[];
  /** Citas que entraron por el agente de WhatsApp esta semana (lunes a domingo). */
  aiBookings: { count: number; recent: AppointmentView[] };
  /** Conversaciones esperando a una persona (módulo WhatsApp); null si el módulo no está compuesto. */
  conversationsWaiting: number | null;
}

export async function getHomeToday(
  executor: Executor,
  businessId: string,
  options: {
    locationIds: readonly string[] | null;
    locationId: string | null;
    now?: Date;
    countConversationsWaiting?: ConversationsWaitingCounter;
  },
): Promise<HomeToday> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const now = options.now ?? new Date();
  const location = options.locationId ? ctx.locations.find((l) => l.id === options.locationId) : null;
  const timezone = location?.timezone ?? ctx.business.timezone;
  const date = localDate(now, timezone);
  const today = localDayBounds(date, timezone);
  const tomorrowEnd = localDayBounds(addDays(date, 1), timezone).end;
  const weekStart = localDayBounds(mondayOf(date), timezone).start;
  const { locationIds } = options;

  const byStatus = Object.fromEntries(APPOINTMENT_STATUSES.map((s) => [s, 0])) as Record<AppointmentStatus, number>;
  const summary: HomeToday = {
    date,
    timezone,
    locationId: options.locationId,
    generatedAt: now.toISOString(),
    today: { total: 0, byStatus },
    upcoming: [],
    unconfirmed: [],
    noShowsToday: [],
    aiBookings: { count: 0, recent: [] },
    conversationsWaiting: null,
  };
  if (locationIds && locationIds.length === 0) return summary;

  const scope: SQL[] = [eq(appointments.businessId, businessId)];
  if (locationIds) scope.push(inArray(appointments.locationId, [...locationIds]));

  const { statusRows, aiCount, aiIds } = await withTenant(executor, businessId, async (tx) => {
    const statusRows = await tx
      .select({ status: appointments.status, n: count() })
      .from(appointments)
      .where(and(...scope, gte(appointments.startsAt, today.start), lt(appointments.startsAt, today.end)))
      .groupBy(appointments.status);
    const aiScope = and(...scope, eq(appointments.channel, "whatsapp_ai"), gte(appointments.createdAt, weekStart));
    const [ai] = await tx.select({ n: count() }).from(appointments).where(aiScope);
    const recent = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(aiScope)
      .orderBy(desc(appointments.createdAt))
      .limit(AI_RECENT_LIMIT);
    return { statusRows, aiCount: Number(ai?.n ?? 0), aiIds: recent.map((r) => r.id) };
  });

  for (const r of statusRows) if (r.status in byStatus) byStatus[r.status as AppointmentStatus] = Number(r.n);

  const filter = { locationIds };
  summary.today.total = Object.values(byStatus).reduce((n, v) => n + v, 0);
  summary.upcoming = await listAppointments(executor, businessId, {
    ...filter,
    from: now,
    to: new Date(now.getTime() + 7 * DAY_MS),
    statuses: ACTIVE_APPOINTMENT_STATUSES,
    limit: UPCOMING_LIMIT,
  });
  summary.unconfirmed = await listAppointments(executor, businessId, { ...filter, from: now, to: tomorrowEnd, statuses: ["pending"], limit: 50 });
  summary.noShowsToday = await listAppointments(executor, businessId, { ...filter, from: today.start, to: today.end, statuses: ["no_show"], limit: 50 });
  summary.aiBookings = { count: aiCount, recent: await getAppointmentsByIds(executor, businessId, aiIds) };
  if (options.countConversationsWaiting) {
    summary.conversationsWaiting = await options.countConversationsWaiting(executor, businessId, locationIds);
  }
  return summary;
}
