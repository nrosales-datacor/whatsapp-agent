import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { memberships, staff, staffHours, timeOff } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que team aporta a Reportes e Inicio (I5), en SQL:
//
//   • Minutos DISPONIBLES por profesional en un rango (la base de la ocupación): su
//     horario semanal en cada sucursal ∩ el horario de esa sucursal (el mismo criterio que
//     la disponibilidad de la agenda), día por día en la zona de la sucursal (respeta el
//     horario de verano), menos sus ausencias y los cierres de la sucursal o del negocio,
//     recortado al rango. Las ausencias se juntan en un multirango antes de restar: dos
//     ausencias que se pisan no se descuentan dos veces.
//   • Último día de actividad de cada membresía (`markMemberActive`): una vez por persona
//     y día, atómico entre réplicas. Con eso la composición cuenta "usuarios activos".
//
// El horario y la zona de cada sucursal son de business: los pasa quien llama (los tiene
// en el contexto del negocio, en caché) y viajan como VALUES dentro de la consulta.
// ─────────────────────────────────────────────────────────────────────────────

/** Sucursal con su zona y su horario semanal (lo que trae el contexto del negocio). */
export interface LocationSchedule {
  id: string;
  timezone: string;
  /** Bloques de apertura: 0 = domingo; horas "HH:MM" o "HH:MM:SS" locales. */
  hours: readonly { weekday: number; opensAt: string; closesAt: string }[];
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Minutos disponibles por profesional ACTIVO en [from, to), en las sucursales dadas
 * (`locations`: las que entran en el cálculo, con su horario). Los profesionales sin
 * horario en esas sucursales no aparecen.
 */
export async function getStaffAvailableMinutes(
  executor: Executor,
  businessId: string,
  input: { from: Date; to: Date; locations: readonly LocationSchedule[] },
): Promise<Map<string, number>> {
  const blocks = input.locations.flatMap((l) => l.hours.map((h) => ({ locationId: l.id.toLowerCase(), ...h })));
  if (input.locations.length === 0 || blocks.length === 0 || input.to.getTime() <= input.from.getTime()) return new Map();
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const locValues: SQL = sql.join(
    input.locations.map((l) => sql`(${l.id.toLowerCase()}::uuid, ${l.timezone}::text)`),
    sql`, `,
  );
  const hourValues: SQL = sql.join(
    blocks.map((b) => sql`(${b.locationId}::uuid, ${b.weekday}::int, ${b.opensAt}::time, ${b.closesAt}::time)`),
    sql`, `,
  );
  const sh = staffHours;
  const rows = await withTenant(executor, businessId, async (tx) =>
    rowsOf<{ staff_id: string; minutes: unknown }>(
      await tx.execute(sql`
        WITH loc(location_id, tz) AS (VALUES ${locValues}),
        lh(location_id, weekday, opens, closes) AS (VALUES ${hourValues}),
        days AS (
          SELECT loc.location_id, loc.tz, d::date AS day
            FROM loc,
                 generate_series(((${from} AT TIME ZONE loc.tz)::date - 1)::timestamp,
                                 ((${to} AT TIME ZONE loc.tz)::date)::timestamp, interval '1 day') AS d
        ),
        work AS (
          SELECT ${sh.staffId} AS staff_id, ${sh.locationId} AS location_id,
                 tstzrange((days.day + greatest(${sh.startsAt}, lh.opens)) AT TIME ZONE days.tz,
                           (days.day + least(${sh.endsAt}, lh.closes)) AT TIME ZONE days.tz, '[)')
                   * tstzrange(${from}, ${to}, '[)') AS r
            FROM ${sh}
            JOIN ${staff} ON ${staff.id} = ${sh.staffId} AND ${staff.active}
            JOIN days ON days.location_id = ${sh.locationId} AND extract(dow FROM days.day)::int = ${sh.weekday}
            JOIN lh ON lh.location_id = ${sh.locationId} AND lh.weekday = ${sh.weekday}
                   AND lh.opens < ${sh.endsAt} AND ${sh.startsAt} < lh.closes
           WHERE ${sh.businessId} = ${businessId}::uuid
        ),
        worked AS (
          SELECT staff_id, location_id, range_agg(r) AS m
            FROM work
           WHERE NOT isempty(r)
           GROUP BY staff_id, location_id
        ),
        off AS (
          SELECT w.staff_id, w.location_id, range_agg(tstzrange(${timeOff.startsAt}, ${timeOff.endsAt}, '[)')) AS m
            FROM worked w
            JOIN ${timeOff} ON ${timeOff.businessId} = ${businessId}::uuid
                 AND ${timeOff.startsAt} < ${to} AND ${timeOff.endsAt} > ${from}
                 AND (${timeOff.staffId} IS NULL OR ${timeOff.staffId} = w.staff_id)
                 AND (${timeOff.locationId} IS NULL OR ${timeOff.locationId} = w.location_id)
           GROUP BY w.staff_id, w.location_id
        ),
        free AS (
          SELECT w.staff_id,
                 (SELECT coalesce(sum(extract(epoch FROM upper(x) - lower(x))), 0)
                    FROM unnest(w.m - coalesce(o.m, '{}'::tstzmultirange)) AS x) AS seconds
            FROM worked w
            LEFT JOIN off o ON o.staff_id = w.staff_id AND o.location_id = w.location_id
        )
        SELECT staff_id::text AS staff_id, sum(seconds) / 60 AS minutes
          FROM free
         GROUP BY staff_id
      `),
    ),
  );
  return new Map(rows.map((r) => [r.staff_id, Math.round(num(r.minutes))]));
}

/**
 * Marca que la persona usó el panel de este negocio el día local `date` ("AAAA-MM-DD").
 * true solo la PRIMERA vez de ese día (entre todas las réplicas: el UPDATE es atómico).
 * SQL crudo a propósito: no toca `updated_at` (no es un cambio de la membresía).
 */
export async function markMemberActive(executor: Executor, businessId: string, userId: string, date: string): Promise<boolean> {
  const rows = await withTenant(executor, businessId, async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${memberships}
           SET last_active_on = ${date}::date
         WHERE ${memberships.businessId} = ${businessId}::uuid
           AND ${memberships.userId} = ${userId.toLowerCase()}::uuid
           AND ${memberships.active}
           AND (${memberships.lastActiveOn} IS NULL OR ${memberships.lastActiveOn} < ${date}::date)
        RETURNING ${memberships.id}
      `),
    ),
  );
  return rows.length > 0;
}
