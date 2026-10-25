import { and, asc, eq, gt, gte, lte, sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { appointments, appointmentServices } from "./schema";

/** Cita completada que terminó en la ventana pedida (seguimiento post-servicio). */
export interface CompletedAppointmentRef {
  id: string;
  clientId: string;
  locationId: string;
  endsAt: Date;
}

/** Duración máxima de una cita que se tiene en cuenta para buscar por inicio (usa el índice por fecha). */
const MAX_APPOINTMENT_HOURS = 24;

/**
 * Citas COMPLETADAS que terminaron entre `from` y `to` (inclusive), las más viejas primero,
 * hasta `limit`. Lee por el índice de inicio (`appointments_business_starts_idx`).
 */
export async function listCompletedAppointmentsEndedBetween(
  executor: Executor,
  businessId: string,
  range: { from: Date; to: Date; limit?: number },
): Promise<CompletedAppointmentRef[]> {
  const startsFrom = new Date(range.from.getTime() - MAX_APPOINTMENT_HOURS * 3_600_000);
  return withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: appointments.id, clientId: appointments.clientId, locationId: appointments.locationId, endsAt: appointments.endsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, businessId),
          eq(appointments.status, "completed"),
          gt(appointments.startsAt, startsFrom),
          lte(appointments.startsAt, range.to),
          gte(appointments.endsAt, range.from),
          lte(appointments.endsAt, range.to),
        ),
      )
      .orderBy(asc(appointments.endsAt))
      .limit(Math.min(Math.max(range.limit ?? 200, 1), 1000)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que el crecimiento (I6) necesita de la agenda, sin leer estas tablas:
//   • Campañas: subconsultas de ids de clientes para armar un segmento (mismo patrón que
//     `clientIdsWithStaffAppointments`) y el conteo de citas que generó una campaña. Las
//     combina con los filtros del CRM (clients) y sus propios envíos (`campaign_sends`).
//   • Reseñas (WhatsApp): las citas completadas que terminaron en una ventana, para el
//     seguimiento post-servicio.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clientes cuyo ÚLTIMO servicio `serviceId` completado fue antes de `before` (p. ej. "la
 * limpieza dental hace más de 6 meses"). Los que nunca lo hicieron no entran.
 */
export function clientIdsLapsedForService(businessId: string, serviceId: string, before: Date): SQL {
  return sql`SELECT ${appointments.clientId} FROM ${appointments}
    JOIN ${appointmentServices} ON ${appointmentServices.appointmentId} = ${appointments.id}
    WHERE ${appointments.businessId} = ${businessId} AND ${appointments.status} = 'completed' AND ${appointmentServices.serviceId} = ${serviceId}
    GROUP BY ${appointments.clientId}
    HAVING max(${appointments.startsAt}) < ${before.toISOString()}::timestamptz`;
}

/** Clientes con una cita próxima sin cancelar (pendiente o confirmada): ya vuelven solos. */
export function clientIdsWithUpcomingAppointments(businessId: string, now: Date): SQL {
  return sql`SELECT ${appointments.clientId} FROM ${appointments}
    WHERE ${appointments.businessId} = ${businessId} AND ${appointments.status} IN ('pending', 'confirmed') AND ${appointments.startsAt} > ${now.toISOString()}::timestamptz`;
}

/** Citas generadas por un envío: las que el cliente creó después de recibirlo. */
export interface AppointmentsAfterSends {
  /** Citas creadas (sin contar las canceladas) después del envío a cada cliente. */
  appointments: number;
  /** Clientes distintos que agendaron. */
  clients: number;
}

/**
 * Citas creadas por cada cliente DESPUÉS de una fecha suya. `sends` es una subconsulta con
 * columnas `client_id` y `sent_at` (la arma Campañas sobre sus envíos). Hasta `withinDays`
 * días después del envío (lo que pasa meses después ya no es por la campaña).
 */
export async function countAppointmentsAfterSends(executor: Executor, businessId: string, sends: SQL, withinDays = 30): Promise<AppointmentsAfterSends> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.execute(sql`
      SELECT count(a.id)::int AS appointments, count(DISTINCT a.client_id)::int AS clients
        FROM (${sends}) s
        JOIN ${appointments} a ON a.client_id = s.client_id
       WHERE a.business_id = ${businessId}
         AND a.status <> 'cancelled'
         AND a.created_at > s.sent_at
         AND a.created_at <= s.sent_at + make_interval(days => ${withinDays})`),
  );
  const row = rowsOf<{ appointments: number | string; clients: number | string }>(rows)[0];
  return { appointments: Number(row?.appointments ?? 0), clients: Number(row?.clients ?? 0) };
}
