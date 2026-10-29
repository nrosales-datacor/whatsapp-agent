import { and, eq, gte, lte, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { aiUsageMonthly, whatsappChannels } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Uso mensual del agente por negocio (`ai_usage_monthly`), portado de
// legacy/src/observabilidad/{uso,costoLlm}.ts: conversaciones iniciadas, mensajes,
// plantillas, tokens y costo estimado del LLM en MILLONÉSIMOS de dólar (entero: un
// acumulado que crece miles de veces por mes no se lleva en float). Es la base de los
// topes mensuales (./limits.ts) y de las métricas de la bandeja.
//
// Incrementos atómicos (INSERT … ON CONFLICT DO UPDATE SET x = x + n). Con una
// transacción abierta quedan junto con la escritura de dominio. El mes es el del
// calendario en UTC (aproximación suficiente para un tope mensual).
// ─────────────────────────────────────────────────────────────────────────────

export interface AiUsageDelta {
  conversationsStarted?: number;
  messagesIn?: number;
  messagesOut?: number;
  marketingTemplates?: number;
  utilityTemplates?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
}

export interface AiUsageSnapshot {
  conversationsStarted: number;
  messagesIn: number;
  messagesOut: number;
  marketingTemplates: number;
  utilityTemplates: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

const EMPTY: AiUsageSnapshot = {
  conversationsStarted: 0,
  messagesIn: 0,
  messagesOut: 0,
  marketingTemplates: 0,
  utilityTemplates: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

/** Primer día del mes de `now` en UTC ("AAAA-MM-01"). */
export function usageMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const nonNegative = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Suma el delta al mes de `now`. No hace nada si el delta es todo cero. */
export async function incrementAiUsage(executor: Executor, businessId: string, delta: AiUsageDelta, now: Date = new Date()): Promise<void> {
  const d = {
    conversationsStarted: nonNegative(delta.conversationsStarted),
    messagesIn: nonNegative(delta.messagesIn),
    messagesOut: nonNegative(delta.messagesOut),
    marketingTemplates: nonNegative(delta.marketingTemplates),
    utilityTemplates: nonNegative(delta.utilityTemplates),
    inputTokens: nonNegative(delta.inputTokens),
    outputTokens: nonNegative(delta.outputTokens),
    estimatedCostUsdMicros: nonNegative(delta.costMicros),
  };
  if (Object.values(d).every((v) => v === 0)) return;
  const t = aiUsageMonthly;
  await withTenant(executor, businessId, (tx) =>
    tx
      .insert(t)
      .values({ businessId, month: usageMonth(now), ...d })
      .onConflictDoUpdate({
        target: [t.businessId, t.month],
        set: {
          conversationsStarted: sql`${t.conversationsStarted} + ${d.conversationsStarted}`,
          messagesIn: sql`${t.messagesIn} + ${d.messagesIn}`,
          messagesOut: sql`${t.messagesOut} + ${d.messagesOut}`,
          marketingTemplates: sql`${t.marketingTemplates} + ${d.marketingTemplates}`,
          utilityTemplates: sql`${t.utilityTemplates} + ${d.utilityTemplates}`,
          inputTokens: sql`${t.inputTokens} + ${d.inputTokens}`,
          outputTokens: sql`${t.outputTokens} + ${d.outputTokens}`,
          estimatedCostUsdMicros: sql`${t.estimatedCostUsdMicros} + ${d.estimatedCostUsdMicros}`,
          updatedAt: new Date(),
        },
      }),
  );
}

function toSnapshot(row: typeof aiUsageMonthly.$inferSelect | undefined): AiUsageSnapshot {
  if (!row) return { ...EMPTY };
  return {
    conversationsStarted: row.conversationsStarted,
    messagesIn: row.messagesIn,
    messagesOut: row.messagesOut,
    marketingTemplates: row.marketingTemplates,
    utilityTemplates: row.utilityTemplates,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    costMicros: Number(row.estimatedCostUsdMicros),
  };
}

/** Uso del mes de `now` (todo en cero si todavía no hubo actividad). */
export async function getAiUsage(executor: Executor, businessId: string, now: Date = new Date()): Promise<AiUsageSnapshot> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(aiUsageMonthly)
      .where(and(eq(aiUsageMonthly.businessId, businessId), eq(aiUsageMonthly.month, usageMonth(now))))
      .limit(1),
  );
  return toSnapshot(row);
}

/**
 * Uso del agente en un mes (`YYYY-MM`) para los planes: lo que la composición le pasa a
 * billing como `aiUsage` (`me.plan.usage`, detalle del superadmin). null = el negocio no
 * tiene WhatsApp conectado (todavía no se mide); con número y sin actividad en el mes,
 * ceros. El mes de esta tabla es el calendario UTC (ver cabecera): en las primeras horas
 * de un mes la vista del plan (mes de Costa Rica) puede ir unas horas atrasada.
 */
export async function readMonthlyAiUsage(
  executor: Executor,
  businessId: string,
  month: string,
): Promise<{ conversations: number; llmCostUsdMicros: number } | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  return withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select({ conversations: aiUsageMonthly.conversationsStarted, costMicros: aiUsageMonthly.estimatedCostUsdMicros })
      .from(aiUsageMonthly)
      .where(and(eq(aiUsageMonthly.businessId, businessId), eq(aiUsageMonthly.month, `${month}-01`)))
      .limit(1);
    if (row) return { conversations: row.conversations, llmCostUsdMicros: Number(row.costMicros) };
    const [channel] = await tx.select({ id: whatsappChannels.id }).from(whatsappChannels).where(eq(whatsappChannels.businessId, businessId)).limit(1);
    return channel ? { conversations: 0, llmCostUsdMicros: 0 } : null;
  });
}

/** Costo del LLM sumado de los meses que tocan [from, to] (aproximación por mes completo). */
export async function aiCostMicrosBetween(executor: Executor, businessId: string, from: Date, to: Date): Promise<number> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ total: sql<string>`coalesce(sum(${aiUsageMonthly.estimatedCostUsdMicros}), 0)` })
      .from(aiUsageMonthly)
      .where(and(eq(aiUsageMonthly.businessId, businessId), gte(aiUsageMonthly.month, usageMonth(from)), lte(aiUsageMonthly.month, usageMonth(to)))),
  );
  return Number(row?.total ?? 0);
}

// Whisper cobra por MINUTO de audio, no por token. Precio actualizable sin deploy.
const WHISPER_USD_PER_MINUTE = (() => {
  const n = Number(process.env.OPENAI_WHISPER_USD_PER_MINUTE);
  return Number.isFinite(n) && n >= 0 && process.env.OPENAI_WHISPER_USD_PER_MINUTE !== "" && process.env.OPENAI_WHISPER_USD_PER_MINUTE !== undefined ? n : 0.006;
})();

/** Costo estimado de transcribir `seconds` de audio, en millonésimos de dólar. */
export function whisperCostMicros(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round((seconds / 60) * WHISPER_USD_PER_MINUTE * 1_000_000);
}
