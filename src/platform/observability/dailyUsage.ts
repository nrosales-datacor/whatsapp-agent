import { and, eq, gte, lte, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../db/scope";
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
