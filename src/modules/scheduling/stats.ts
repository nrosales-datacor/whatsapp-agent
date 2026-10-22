import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { APPOINTMENT_STATUSES, appointments, appointmentServices, type AppointmentChannel, type AppointmentStatus } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Agregados de la agenda para Reportes e Inicio completo (I5, PLAN-GESTION.md §2
// "Medible"): TODO en SQL, con rango e índices (nada de traer las citas a memoria).
// Solo lectura, con el contexto del negocio. Los usa el módulo reports (que depende de
// scheduling; scheduling no conoce a reports).
//
//   • Rango de citas: las que EMPIEZAN en [from, to). La ocupación usa las que se
//     SOLAPAN con el rango, recortadas a él.
//   • Sucursal: `locationIds` acota a esas (null/ausente = todas; [] = ninguna).
//   • Día: el día local de `timeZone` ("AAAA-MM-DD").
//   • Visita = cita completada (igual que la caché de visitas del cliente).
//
// `attributeAmounts` es la pieza que usa sales para repartir lo cobrado por profesional,
// servicio o canal: sales le pasa SU subconsulta de montos (sus tablas) y acá se cruza
// con las citas y sus líneas (las nuestras) en UNA sentencia, con el mismo prorrateo por
// precio que las comisiones. Así ningún módulo lee las tablas del otro.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre de cada canal de cita en reportes y exportaciones. */
export const CHANNEL_LABELS: Readonly<Record<AppointmentChannel, string>> = {
  whatsapp_ai: "Agente de WhatsApp",
  panel: "Panel",
  phone: "Teléfono",
  walk_in: "Presencial",
  web: "Web",
};

export interface StatsRange {
  from: Date;
  to: Date;
  /** null/ausente = todas las sucursales; [] = ninguna (resultado vacío). */
  locationIds?: readonly string[] | null;
  /** Solo las citas de este profesional. */
  staffId?: string | null;
}

export type AppointmentGroupBy = "status" | "channel" | "staff" | "location" | "day";

export interface AppointmentCounts {
  total: number;
  byStatus: Record<AppointmentStatus, number>;
  /** Valor (precios copiados en la cita) de las completadas: lo "facturado", no lo cobrado. */
  completedValueCents: number;
}

export interface AppointmentGroup extends AppointmentCounts {
  /** Estado, canal, id de profesional o sucursal, o "AAAA-MM-DD". */
  key: string;
}

export interface AppointmentBreakdown extends AppointmentCounts {
  groupBy: AppointmentGroupBy | null;
  /** Por clave (por día: cronológico; el resto, por total de mayor a menor). */
  groups: AppointmentGroup[];
}

const emptyByStatus = (): Record<AppointmentStatus, number> =>
  Object.fromEntries(APPOINTMENT_STATUSES.map((s) => [s, 0])) as Record<AppointmentStatus, number>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Instante como parámetro ISO (igual en postgres.js y PGlite). */
const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** Lista de uuids para `IN (…)` (siempre con al menos uno: el llamador descarta la lista vacía). */
const uuidList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id.toLowerCase()}::uuid`), sql`, `);

/** Condiciones comunes sobre `appointments` (alias implícito: la tabla). null = sin resultado posible. */
function scopeOf(businessId: string, input: StatsRange, column: "starts" | "overlap"): SQL | null {
  if (input.locationIds && input.locationIds.length === 0) return null;
  const parts: SQL[] = [sql`${appointments.businessId} = ${businessId}::uuid`];
  if (column === "starts") parts.push(sql`${appointments.startsAt} >= ${at(input.from)}`, sql`${appointments.startsAt} < ${at(input.to)}`);
  else parts.push(sql`${appointments.startsAt} < ${at(input.to)}`, sql`${appointments.endsAt} > ${at(input.from)}`);
  if (input.locationIds) parts.push(sql`${appointments.locationId} IN (${uuidList(input.locationIds)})`);
  if (input.staffId) parts.push(sql`${appointments.staffId} = ${input.staffId.toLowerCase()}::uuid`);
  return sql.join(parts, sql` AND `);
}

function keyExpression(groupBy: AppointmentGroupBy | null, timeZone: string): SQL {
  switch (groupBy) {
    case "status":
      return sql`${appointments.status}`;
    case "channel":
      return sql`${appointments.channel}`;
    case "staff":
      return sql`${appointments.staffId}::text`;
    case "location":
      return sql`${appointments.locationId}::text`;
    case "day":
      return sql`to_char(${appointments.startsAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
    default:
      return sql`''`;
  }
}

type CountRow = Record<AppointmentStatus, unknown> & { key: string; total: unknown; completed_value: unknown };

function countsOf(row: CountRow): AppointmentCounts {
  const byStatus = emptyByStatus();
  for (const s of APPOINTMENT_STATUSES) byStatus[s] = num(row[s]);
  return { total: num(row.total), byStatus, completedValueCents: num(row.completed_value) };
}

/**
 * Citas que empiezan en [from, to) por estado, canal, profesional, sucursal o día local,
 * con el desglose por estado de cada grupo (cancelados y no-show incluidos: el reporte
 * decide qué mostrar). Sin `groupBy`, solo los totales.
 */
export async function getAppointmentBreakdown(
  executor: Executor,
  businessId: string,
  input: StatsRange & { groupBy?: AppointmentGroupBy | null; timeZone?: string },
): Promise<AppointmentBreakdown> {
  const groupBy = input.groupBy ?? null;
  const empty: AppointmentBreakdown = { total: 0, byStatus: emptyByStatus(), completedValueCents: 0, groupBy, groups: [] };
  const scope = scopeOf(businessId, input, "starts");
  if (!scope) return empty;
  const key = keyExpression(groupBy, input.timeZone ?? "UTC");
  const statusCounts = sql.join(
    APPOINTMENT_STATUSES.map((s) => sql`count(*) FILTER (WHERE ${appointments.status} = ${s}) AS ${sql.identifier(s)}`),
    sql`, `,
  );
  const rows = await withTenant(executor, businessId, async (tx) =>
    rowsOf<CountRow>(
      await tx.execute(sql`
        SELECT ${key} AS key, count(*) AS total, ${statusCounts},
               coalesce(sum(${appointments.totalCents}) FILTER (WHERE ${appointments.status} = 'completed'), 0) AS completed_value
          FROM ${appointments}
         WHERE ${scope}
         GROUP BY 1
         ORDER BY 1
      `),
    ),
  );
  const groups = rows.map((r) => ({ key: String(r.key), ...countsOf(r) }));
  const totals = groups.reduce(
    (acc, g) => {
      acc.total += g.total;
      acc.completedValueCents += g.completedValueCents;
      for (const s of APPOINTMENT_STATUSES) acc.byStatus[s] += g.byStatus[s];
      return acc;
    },
    { total: 0, completedValueCents: 0, byStatus: emptyByStatus() },
  );
  if (groupBy !== "day") groups.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return { ...totals, groupBy, groups: groupBy ? groups : [] };
}

// ── Servicios ───────────────────────────────────────────────────────────────

export interface ServiceLineStats {
  /** null = el servicio ya no existe (la línea conserva su nombre). */
  serviceId: string | null;
  /** Nombre copiado en las líneas (el más reciente alfabéticamente si cambió). */
  name: string;
  /** Líneas en citas no canceladas (agendadas, incluye no-show). */
  scheduled: number;
  /** Líneas en citas completadas (lo "vendido"). */
  completed: number;
  /** Precio copiado de las líneas completadas. */
  completedValueCents: number;
}

/** Líneas de servicio de las citas que empiezan en [from, to), por servicio. */
export async function getServiceLineStats(executor: Executor, businessId: string, input: StatsRange): Promise<ServiceLineStats[]> {
  const scope = scopeOf(businessId, input, "starts");
  if (!scope) return [];
  const s = appointmentServices;
  const rows = await withTenant(executor, businessId, async (tx) =>
    rowsOf<{ service_id: string | null; name: string; scheduled: unknown; completed: unknown; completed_value: unknown }>(
      await tx.execute(sql`
        SELECT ${s.serviceId}::text AS service_id, max(${s.name}) AS name,
               count(*) FILTER (WHERE ${appointments.status} <> 'cancelled') AS scheduled,
               count(*) FILTER (WHERE ${appointments.status} = 'completed') AS completed,
               coalesce(sum(${s.priceCents}) FILTER (WHERE ${appointments.status} = 'completed'), 0) AS completed_value
          FROM ${s}
          JOIN ${appointments} ON ${appointments.id} = ${s.appointmentId}
         WHERE ${s.businessId} = ${businessId}::uuid AND ${scope}
         GROUP BY ${s.serviceId}, CASE WHEN ${s.serviceId} IS NULL THEN ${s.name} END
      `),
    ),
  );
  return rows
    .map((r) => ({
      serviceId: r.service_id,
      name: r.name,
      scheduled: num(r.scheduled),
      completed: num(r.completed),
      completedValueCents: num(r.completed_value),
    }))
    .sort((a, b) => b.completed - a.completed || b.scheduled - a.scheduled || a.name.localeCompare(b.name, "es"));
}

// ── Ocupación ───────────────────────────────────────────────────────────────

/**
 * Minutos AGENDADOS por profesional: lo que ocupan sus citas no canceladas (incluye el
 * buffer y los no-show: el lugar estuvo reservado) que se solapan con [from, to),
 * recortadas al rango. Los profesionales sin citas no aparecen.
 */
export async function getBookedMinutesByStaff(executor: Executor, businessId: string, input: StatsRange): Promise<Map<string, number>> {
  const scope = scopeOf(businessId, input, "overlap");
  if (!scope) return new Map();
  const rows = await withTenant(executor, businessId, async (tx) =>
    rowsOf<{ staff_id: string; minutes: unknown }>(
      await tx.execute(sql`
        SELECT ${appointments.staffId}::text AS staff_id,
               coalesce(sum(extract(epoch FROM least(${appointments.endsAt}, ${at(input.to)})
                                             - greatest(${appointments.startsAt}, ${at(input.from)}))), 0) / 60 AS minutes
          FROM ${appointments}
         WHERE ${scope} AND ${appointments.status} <> 'cancelled'
         GROUP BY 1
      `),
    ),
  );
  return new Map(rows.map((r) => [r.staff_id, Math.round(num(r.minutes))]));
}

// ── Clientes atendidos ──────────────────────────────────────────────────────

export interface ClientVisitStats {
  /** Visitas (citas completadas) en el rango. */
  visits: number;
  /** Clientes distintos atendidos en el rango. */
  served: number;
  /** De esos, los que tuvieron su PRIMERA visita del negocio (en cualquier sucursal) en el rango. */
  newClients: number;
  /** Atendidos que ya habían venido antes del rango. */
  returning: number;
  /** Retención simple: de los atendidos en [previousFrom, from), cuántos volvieron en el rango. */
  previous: { from: string; to: string; served: number; retained: number };
  /** retained / previous.served (0–1); null sin atendidos en el período anterior. */
  retentionRate: number | null;
  /** Por día local: clientes nuevos (su primera visita) y recurrentes atendidos ese día. */
  byDay: { date: string; newClients: number; returningClients: number }[];
}

/**
 * Clientes nuevos vs. recurrentes en [from, to) y la retención contra el período anterior
 * [previousFrom, from). "Nuevo" = su primera visita del negocio cae en el rango (se mira
 * el historial completo, no solo la sucursal elegida).
 */
export async function getClientVisitStats(
  executor: Executor,
  businessId: string,
  input: { from: Date; to: Date; previousFrom: Date; locationIds?: readonly string[] | null; timeZone: string },
): Promise<ClientVisitStats> {
  const previous = { from: input.previousFrom.toISOString(), to: input.from.toISOString(), served: 0, retained: 0 };
  const empty: ClientVisitStats = { visits: 0, served: 0, newClients: 0, returning: 0, previous, retentionRate: null, byDay: [] };
  const current = scopeOf(businessId, input, "starts");
  const before = scopeOf(businessId, { ...input, from: input.previousFrom, to: input.from }, "starts");
  if (!current || !before) return empty;
  const a = appointments;

  return withTenant(executor, businessId, async (tx) => {
    const visitsCte = sql`
      visits AS (
        SELECT ${a.clientId} AS client_id, ${a.startsAt} AS starts_at
          FROM ${a}
         WHERE ${current} AND ${a.status} = 'completed'
      ),
      served AS (
        SELECT v.client_id, min(v.starts_at) AS first_in_range,
               NOT EXISTS (
                 SELECT 1 FROM ${a} p
                  WHERE p.business_id = ${businessId}::uuid AND p.client_id = v.client_id
                    AND p.status = 'completed' AND p.starts_at < ${at(input.from)}
               ) AS is_new
          FROM visits v
         GROUP BY v.client_id
      )`;
    const [totals] = rowsOf<{ visits: unknown; served: unknown; new_clients: unknown }>(
      await tx.execute(sql`
        WITH ${visitsCte}
        SELECT (SELECT count(*) FROM visits) AS visits, count(*) AS served, count(*) FILTER (WHERE is_new) AS new_clients
          FROM served
      `),
    );
    const byDay = rowsOf<{ day: string; new_clients: unknown; returning: unknown }>(
      await tx.execute(sql`
        WITH ${visitsCte}
        SELECT to_char(v.starts_at AT TIME ZONE ${input.timeZone}, 'YYYY-MM-DD') AS day,
               count(DISTINCT v.client_id) FILTER (WHERE s.is_new AND v.starts_at = s.first_in_range) AS new_clients,
               count(DISTINCT v.client_id) FILTER (WHERE NOT (s.is_new AND v.starts_at = s.first_in_range)) AS returning
          FROM visits v
          JOIN served s ON s.client_id = v.client_id
         GROUP BY 1
         ORDER BY 1
      `),
    );
    const [retention] = rowsOf<{ previous_served: unknown; retained: unknown }>(
      await tx.execute(sql`
        WITH prev AS (SELECT DISTINCT ${a.clientId} AS client_id FROM ${a} WHERE ${before} AND ${a.status} = 'completed'),
             cur AS (SELECT DISTINCT ${a.clientId} AS client_id FROM ${a} WHERE ${current} AND ${a.status} = 'completed')
        SELECT (SELECT count(*) FROM prev) AS previous_served,
               (SELECT count(*) FROM prev JOIN cur ON cur.client_id = prev.client_id) AS retained
      `),
    );
    const served = num(totals?.served);
    const newClients = num(totals?.new_clients);
    previous.served = num(retention?.previous_served);
    previous.retained = num(retention?.retained);
    return {
      visits: num(totals?.visits),
      served,
      newClients,
      returning: served - newClients,
      previous,
      retentionRate: previous.served > 0 ? previous.retained / previous.served : null,
      byDay: byDay.map((r) => ({ date: r.day, newClients: num(r.new_clients), returningClients: num(r.returning) })),
    };
  });
}

// ── Montos atribuidos a citas (para sales) ──────────────────────────────────

/** Por qué agrupar: profesional, servicio o canal de la cita, o `source` = la `group_key` de la subconsulta. */
export type AttributionKey = "staff" | "service" | "channel" | "source";

/**
 * Subconsulta de montos que se atribuyen a citas. Columnas, en este orden y con estos
 * nombres: `movement_id` uuid (un movimiento = una fila), `appointment_id` uuid o NULL
 * (monto suelto), `kind` text (opaco: se agrupa por él), `amount` bigint > 0, `ticket`
 * text o NULL (identidad para contar "tickets" distintos; NULL = no cuenta) y `group_key`
 * text o NULL (clave propia del llamador, para `groupBy: "source"`).
 */
export type AmountsSubquery = SQL;

export interface AttributionInput {
  amounts: AmountsSubquery;
  /** Repartir cada monto entre las líneas de su cita en proporción al precio (como las comisiones). */
  splitByService: boolean;
  groupBy: AttributionKey | null;
  /** Solo lo de citas de este profesional (los montos sueltos quedan afuera). */
  staffId?: string | null;
  /** Solo la parte que corresponde a este servicio (exige `splitByService`). */
  serviceId?: string | null;
}

export interface AttributedGroup {
  /** Id del profesional o del servicio, el canal, la `group_key`, o null (monto suelto o servicio que ya no existe). */
  key: string | null;
  /** Nombre copiado de la línea (solo al agrupar por servicio); null en los montos sueltos. */
  name: string | null;
  kind: string;
  amountCents: number;
  /** Porciones (filas) que sumaron: con reparto, una por línea. */
  portions: number;
}

export interface Attribution {
  groups: AttributedGroup[];
  /** Totales por `kind`: monto y movimientos distintos que aportaron. */
  byKind: { kind: string; amountCents: number; movements: number }[];
  /** Movimientos distintos que aportaron algo. */
  movements: number;
  /** `ticket` distintos (no nulos) de lo que aportó. */
  tickets: number;
}

/** Porciones de cada movimiento: (movement_id, kind, ticket, group_key, staff_key, channel, service_key, name, share). */
function portionsSql(businessId: string, input: AttributionInput): SQL {
  const a = appointments;
  const l = appointmentServices;
  if (!input.splitByService) {
    return sql`
      SELECT m.movement_id, m.kind, m.ticket, m.group_key, a.staff_id::text AS staff_key, a.channel AS channel,
             NULL::text AS service_key, NULL::text AS name, m.amount::bigint AS share
        FROM m
        LEFT JOIN ${a} a ON a.id = m.appointment_id AND a.business_id = ${businessId}::uuid`;
  }
  // Prorrateo por precio con resto mayor (mismo resultado que `prorateByPrice` de sales):
  // base = piso(monto × precio / total); lo que falta para llegar al monto se reparte de a
  // un céntimo entre las líneas con mayor fracción (desempate: el orden de la cita). Sin
  // precios, todo a la primera línea. Aritmética en numeric: monto × precio no desborda.
  return sql`
    SELECT movement_id, kind, ticket, group_key, staff_key, channel, service_key, name,
           (base + CASE WHEN rk <= rest THEN 1 ELSE 0 END)::bigint AS share
      FROM (
        SELECT r.*, r.amount - sum(r.base) OVER (PARTITION BY r.movement_id) AS rest,
               row_number() OVER (PARTITION BY r.movement_id ORDER BY r.frac DESC, r.idx) AS rk
          FROM (
            SELECT m.movement_id, m.kind, m.ticket, m.group_key, m.amount::numeric AS amount,
                   a.staff_id::text AS staff_key, a.channel AS channel, li.service_id::text AS service_key, li.name, li.idx,
                   CASE WHEN li.total_price > 0 THEN floor(m.amount::numeric * li.price / li.total_price)
                        WHEN li.idx = 1 THEN m.amount::numeric ELSE 0 END AS base,
                   CASE WHEN li.total_price > 0 THEN mod(m.amount::numeric * li.price, li.total_price) ELSE 0 END AS frac
              FROM m
              JOIN ${a} a ON a.id = m.appointment_id AND a.business_id = ${businessId}::uuid
              JOIN (
                SELECT ${l.appointmentId} AS appointment_id, ${l.serviceId} AS service_id, ${l.name} AS name,
                       ${l.priceCents}::numeric AS price,
                       sum(${l.priceCents}::numeric) OVER (PARTITION BY ${l.appointmentId}) AS total_price,
                       row_number() OVER (PARTITION BY ${l.appointmentId} ORDER BY ${l.position}, ${l.id}) AS idx
                  FROM ${l}
                 WHERE ${l.businessId} = ${businessId}::uuid
                   AND ${l.appointmentId} IN (SELECT appointment_id FROM m WHERE appointment_id IS NOT NULL)
              ) li ON li.appointment_id = m.appointment_id
          ) r
      ) shares
    UNION ALL
    SELECT m.movement_id, m.kind, m.ticket, m.group_key, NULL, NULL, NULL, NULL, m.amount::bigint
      FROM m
     WHERE m.appointment_id IS NULL`;
}

/**
 * Atribuye montos (de otro módulo, ver `AmountsSubquery`) a las citas: por profesional,
 * servicio (con prorrateo entre líneas) o canal, con filtros por profesional y servicio.
 * Todo en UNA consulta; corre con el contexto del negocio (o en la transacción `tx`).
 */
export async function attributeAmounts(executor: Executor | Tx, businessId: string, input: AttributionInput): Promise<Attribution> {
  const filters: SQL[] = [sql`share > 0`];
  if (input.staffId) filters.push(sql`staff_key = ${input.staffId.toLowerCase()}`);
  if (input.serviceId) filters.push(sql`service_key = ${input.serviceId.toLowerCase()}`);
  const where = sql.join(filters, sql` AND `);
  const key =
    input.groupBy === "staff"
      ? sql`staff_key`
      : input.groupBy === "service"
        ? sql`service_key`
        : input.groupBy === "channel"
          ? sql`channel`
          : input.groupBy === "source"
            ? sql`group_key`
            : sql`NULL::text`;
  // Las líneas de un servicio que ya no existe se agrupan por su nombre (clave null).
  const name = input.groupBy === "service" ? sql`CASE WHEN service_key IS NULL THEN name END` : sql`NULL::text`;
  const base = sql`WITH m AS (${input.amounts}), p AS (${portionsSql(businessId, input)})`;

  return withTenant(executor, businessId, async (tx) => {
    const groups = rowsOf<{ key: string | null; name: string | null; label: string | null; kind: string; amount: unknown; portions: unknown }>(
      await tx.execute(sql`
        ${base}
        SELECT ${key} AS key, ${name} AS name, max(name) AS label, kind, sum(share) AS amount, count(*) AS portions
          FROM p
         WHERE ${where}
         GROUP BY 1, 2, kind
      `),
    );
    const byKind = rowsOf<{ kind: string; amount: unknown; movements: unknown }>(
      await tx.execute(sql`
        ${base}
        SELECT kind, sum(share) AS amount, count(DISTINCT movement_id) AS movements
          FROM p
         WHERE ${where}
         GROUP BY kind
      `),
    );
    const [overall] = rowsOf<{ movements: unknown; tickets: unknown }>(
      await tx.execute(sql`
        ${base}
        SELECT count(DISTINCT movement_id) AS movements, count(DISTINCT ticket) AS tickets
          FROM p
         WHERE ${where}
      `),
    );
    return {
      groups: groups.map((g) => ({
        key: g.key,
        name: input.groupBy === "service" ? (g.name ?? g.label) : null,
        kind: g.kind,
        amountCents: num(g.amount),
        portions: num(g.portions),
      })),
      byKind: byKind.map((k) => ({ kind: k.kind, amountCents: num(k.amount), movements: num(k.movements) })),
      movements: num(overall?.movements),
      tickets: num(overall?.tickets),
    };
  });
}
