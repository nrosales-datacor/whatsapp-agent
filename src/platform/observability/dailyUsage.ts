import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { withSystem, withTenant, type Executor } from "../db/scope";
import { dailyUsage } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Uso diario por negocio y métrica (`daily_usage`, PLAN-GESTION.md §2 "Medible"): un
// contador por (negocio, día local, métrica) con incrementos atómicos. Lo usan los
// módulos para eventos que no quedan en sus propias tablas (p. ej. cuántas veces el
// agente pasó una conversación a una persona) y el superadmin para activación.
//
// Si recibe una transacción abierta (`Tx`), el incremento queda atómico con la escritura
// de dominio; con la base, abre la suya con el contexto del negocio.
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_PATTERN = /^[a-z][a-z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertInput(metric: string, date: string): void {
  if (!METRIC_PATTERN.test(metric)) throw new Error(`daily_usage: métrica inválida "${metric}" (snake_case)`);
  if (!DATE_PATTERN.test(date)) throw new Error(`daily_usage: fecha inválida "${date}" (AAAA-MM-DD)`);
}

/** Suma `by` (default 1) a la métrica del negocio en el día local `date` ("AAAA-MM-DD"). */
export async function incrementDailyUsage(
  executor: Executor,
  businessId: string,
  input: { date: string; metric: string; by?: number },
): Promise<void> {
  assertInput(input.metric, input.date);
  const by = input.by ?? 1;
  if (!Number.isSafeInteger(by) || by === 0) return;
  await withTenant(executor, businessId, (tx) =>
    tx
      .insert(dailyUsage)
      .values({ businessId, date: input.date, metric: input.metric, value: by })
      .onConflictDoUpdate({
        target: [dailyUsage.businessId, dailyUsage.date, dailyUsage.metric],
        set: { value: sql`${dailyUsage.value} + ${by}`, updatedAt: new Date() },
      }),
  );
}

/** Valores de una métrica por día en [from, to] (ambos inclusive, "AAAA-MM-DD"). Los días sin fila no aparecen. */
export async function readDailyUsage(
  executor: Executor,
  businessId: string,
  input: { metric: string; from: string; to: string },
): Promise<{ date: string; value: number }[]> {
  assertInput(input.metric, input.from);
  assertInput(input.metric, input.to);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ date: dailyUsage.date, value: dailyUsage.value })
      .from(dailyUsage)
      .where(
        and(
          eq(dailyUsage.businessId, businessId),
          eq(dailyUsage.metric, input.metric),
          gte(dailyUsage.date, input.from),
          lte(dailyUsage.date, input.to),
        ),
      )
      .orderBy(dailyUsage.date),
  );
  return rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
}

// ── Lectura de la plataforma (superadmin, contexto de sistema) ──────────────

/** Métricas que registra la composición y los módulos (las que muestra el superadmin). */
export const USAGE_METRICS = {
  /** Citas creadas (panel y agente de WhatsApp). */
  appointmentsCreated: "appointments_created",
  /** Señas y cobros registrados (sin devoluciones). */
  paymentsRecorded: "payments_recorded",
  /** Personas distintas que usaron el panel ese día (una vez por persona y día). */
  activeUsers: "active_users",
  /** Logins correctos. */
  logins: "logins",
  /** Conversaciones del agente iniciadas (primer mensaje del cliente tras 24 h, como cobra Meta). */
  aiConversations: "ai_conversations",
  /** Conversaciones que el agente pasó a una persona. */
  whatsappHandoffs: "whatsapp_handoffs",
} as const;

export interface UsageSummaryRow {
  businessId: string;
  metric: string;
  /** Suma del período. */
  total: number;
  /** Días con valor > 0. */
  activeDays: number;
  /** Último día con valor > 0 ("AAAA-MM-DD"). */
  lastDate: string | null;
}

function assertRange(from: string, to: string): void {
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) throw new Error("daily_usage: rango inválido (AAAA-MM-DD)");
}

function metricsFilter(metrics: readonly string[] | undefined) {
  if (!metrics) return undefined;
  for (const m of metrics) if (!METRIC_PATTERN.test(m)) throw new Error(`daily_usage: métrica inválida "${m}" (snake_case)`);
  return metrics.length > 0 ? inArray(dailyUsage.metric, [...metrics]) : sql`false`;
}

/** Suma por negocio y métrica en [from, to] (inclusive) de TODOS los negocios (superadmin). */
export async function summarizeDailyUsage(
  executor: Executor,
  input: { from: string; to: string; metrics?: readonly string[] },
): Promise<UsageSummaryRow[]> {
  assertRange(input.from, input.to);
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({
        businessId: dailyUsage.businessId,
        metric: dailyUsage.metric,
        total: sql<string>`sum(${dailyUsage.value})`,
        activeDays: sql<string>`count(*) FILTER (WHERE ${dailyUsage.value} > 0)`,
        lastDate: sql<string | null>`(max(${dailyUsage.date}) FILTER (WHERE ${dailyUsage.value} > 0))::text`,
      })
      .from(dailyUsage)
      .where(and(gte(dailyUsage.date, input.from), lte(dailyUsage.date, input.to), metricsFilter(input.metrics)))
      .groupBy(dailyUsage.businessId, dailyUsage.metric),
  );
  return rows.map((r) => ({
    businessId: r.businessId,
    metric: r.metric,
    total: Number(r.total ?? 0),
    activeDays: Number(r.activeDays ?? 0),
    lastDate: r.lastDate ? String(r.lastDate).slice(0, 10) : null,
  }));
}

/**
 * Serie por día y métrica en [from, to] (inclusive): suma y negocios con valor > 0. De
 * todos los negocios, o de uno (`businessId`). Los días sin filas no aparecen.
 */
export async function dailyUsageSeries(
  executor: Executor,
  input: { from: string; to: string; metrics?: readonly string[]; businessId?: string },
): Promise<{ date: string; metric: string; total: number; businesses: number }[]> {
  assertRange(input.from, input.to);
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({
        date: dailyUsage.date,
        metric: dailyUsage.metric,
        total: sql<string>`sum(${dailyUsage.value})`,
        businesses: sql<string>`count(DISTINCT ${dailyUsage.businessId}) FILTER (WHERE ${dailyUsage.value} > 0)`,
      })
      .from(dailyUsage)
      .where(
        and(
          gte(dailyUsage.date, input.from),
          lte(dailyUsage.date, input.to),
          metricsFilter(input.metrics),
          input.businessId ? eq(dailyUsage.businessId, input.businessId) : undefined,
        ),
      )
      .groupBy(dailyUsage.date, dailyUsage.metric)
      .orderBy(dailyUsage.date),
  );
  return rows.map((r) => ({ date: String(r.date).slice(0, 10), metric: r.metric, total: Number(r.total ?? 0), businesses: Number(r.businesses ?? 0) }));
}

/** Primer día con valor > 0 de cada métrica por negocio (hitos de activación), de toda la historia. */
export async function firstUsageDates(
  executor: Executor,
  input: { metrics: readonly string[]; businessId?: string },
): Promise<{ businessId: string; metric: string; firstDate: string }[]> {
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({ businessId: dailyUsage.businessId, metric: dailyUsage.metric, firstDate: sql<string>`min(${dailyUsage.date})::text` })
      .from(dailyUsage)
      .where(
        and(
          sql`${dailyUsage.value} > 0`,
          metricsFilter(input.metrics),
          input.businessId ? eq(dailyUsage.businessId, input.businessId) : undefined,
        ),
      )
      .groupBy(dailyUsage.businessId, dailyUsage.metric),
  );
  return rows.map((r) => ({ businessId: r.businessId, metric: r.metric, firstDate: String(r.firstDate).slice(0, 10) }));
}

/** Negocios con alguna de las métricas > 0, por día, en [from, to] (inclusive). */
export async function activeBusinessesByDay(
  executor: Executor,
  input: { from: string; to: string; metrics: readonly string[] },
): Promise<{ date: string; businesses: number }[]> {
  assertRange(input.from, input.to);
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({ date: dailyUsage.date, businesses: sql<string>`count(DISTINCT ${dailyUsage.businessId})` })
      .from(dailyUsage)
      .where(and(gte(dailyUsage.date, input.from), lte(dailyUsage.date, input.to), sql`${dailyUsage.value} > 0`, metricsFilter(input.metrics)))
      .groupBy(dailyUsage.date)
      .orderBy(dailyUsage.date),
  );
  return rows.map((r) => ({ date: String(r.date).slice(0, 10), businesses: Number(r.businesses ?? 0) }));
}
