import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { ACTIVE_APPOINTMENT_STATUSES, appointments, type AppointmentChannel } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Consultas agregadas de la agenda que piden otros módulos (bandeja y métricas del agente
// de WhatsApp): la próxima cita de varios clientes de una vez y las citas que entraron
// por un canal en un rango, por día local. Solo lectura, con el contexto del negocio.
// ─────────────────────────────────────────────────────────────────────────────

/** Próxima cita viva (pendiente o confirmada) de cada cliente, desde `now`. Los que no tienen, no aparecen. */
export async function nextAppointmentsForClients(
  executor: Executor,
  businessId: string,
  clientIds: readonly string[],
  options: { now?: Date } = {},
): Promise<Map<string, { id: string; startsAt: string }>> {
  const ids = [...new Set(clientIds.filter(isTenantId).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const now = options.now ?? new Date();
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .selectDistinctOn([appointments.clientId], {
        clientId: appointments.clientId,
        id: appointments.id,
        startsAt: appointments.startsAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, businessId),
          inArray(appointments.clientId, ids),
          inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
          gte(appointments.startsAt, now),
        ),
      )
      .orderBy(asc(appointments.clientId), asc(appointments.startsAt)),
  );
  return new Map(rows.map((r) => [r.clientId, { id: r.id, startsAt: r.startsAt.toISOString() }]));
}

/**
 * Citas CREADAS por un canal en [from, to) (p. ej. las que agendó el agente de WhatsApp),
 * con el desglose por día local de `timeZone` ("AAAA-MM-DD"). Cuentan todas, aunque
 * después se hayan cancelado: mide lo que el canal agendó. `locationIds` acota a esas
 * sucursales (null = todas).
 */
export async function countBookingsByChannel(
  executor: Executor,
  businessId: string,
  input: { channel: AppointmentChannel; from: Date; to: Date; timeZone: string; locationIds?: readonly string[] | null },
): Promise<{ total: number; byDay: { date: string; count: number }[] }> {
  if (input.locationIds && input.locationIds.length === 0) return { total: 0, byDay: [] };
  return withTenant(executor, businessId, async (tx) => {
    const scope = and(
      eq(appointments.businessId, businessId),
      eq(appointments.channel, input.channel),
      gte(appointments.createdAt, input.from),
      lt(appointments.createdAt, input.to),
      input.locationIds ? inArray(appointments.locationId, [...input.locationIds]) : undefined,
    );
    const [total] = await tx.select({ n: count() }).from(appointments).where(scope);
    const byDay = rowsOf<{ day: string; n: number | string }>(
      await tx.execute(sql`
        SELECT to_char(${appointments.createdAt} AT TIME ZONE ${input.timeZone}, 'YYYY-MM-DD') AS day, count(*) AS n
          FROM ${appointments}
         WHERE ${scope}
         GROUP BY 1
         ORDER BY 1
      `),
    );
    return { total: Number(total?.n ?? 0), byDay: byDay.map((r) => ({ date: r.day, count: Number(r.n) })) };
  });
}
