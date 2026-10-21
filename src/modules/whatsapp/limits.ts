import type { AiUsageSnapshot } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Frenos de costo del agente, portados de legacy/src/red/{limiteIngesta,limiteCliente}.ts
// y legacy/src/observabilidad/cuotas.ts:
//
//   1. Ingesta por negocio (token bucket en memoria, en el webhook): al pasarse, el
//      mensaje se guarda y encola IGUAL pero diferido unos segundos. Nunca se pierde: solo
//      se degrada la latencia de esa respuesta.
//   2. Por cliente final (antes de llamar al LLM, en el pipeline): un bucle con otro bot
//      (el mismo texto muchas veces en pocos minutos) pausa el bot en esa conversación;
//      demasiados turnos del agente por hora → aviso neutro UNA vez y no se llama al LLM.
//   3. Topes mensuales del plan: conversaciones y gasto de LLM. Al 100% el bot deja de
//      llamar al LLM, avisa al cliente y pasa la conversación a una persona.
//
// Los límites del plan salen de `getAiLimits(businessId)`, inyectable desde la
// composición. TODO(billing): reemplazar `defaultAiLimits` por los límites del plan del
// negocio (src/modules/billing); hasta entonces, defaults por env iguales para todos.
// ─────────────────────────────────────────────────────────────────────────────

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── 3. Topes mensuales del plan ──────────────────────────────────────────────

export interface AiLimits {
  /** Conversaciones iniciadas por mes (como cobra Meta: primer mensaje tras 24 h). null = sin tope. */
  monthlyConversations: number | null;
  /** Gasto estimado de LLM por mes, en millonésimos de dólar. null = sin tope. */
  monthlySpendMicros: number | null;
}

/** Límites de IA del negocio. Lo inyecta la composición (billing); ver cabecera. */
export type AiLimitsResolver = (businessId: string) => AiLimits | Promise<AiLimits>;

/**
 * Defaults por env, iguales para todos los negocios (0 = sin tope).
 * TODO(billing): los límites reales salen del plan del negocio (PLAN-GESTION.md §5).
 */
export const defaultAiLimits: AiLimitsResolver = () => {
  const conversations = intFromEnv("WHATSAPP_MONTHLY_CONVERSATIONS_CAP", 500);
  const spendUsd = numberFromEnv("WHATSAPP_MONTHLY_AI_SPEND_CAP_USD", 25);
  return {
    monthlyConversations: conversations === 0 ? null : conversations,
    monthlySpendMicros: spendUsd === 0 ? null : Math.round(spendUsd * 1_000_000),
  };
};

export interface CapStatus {
  conversationsExceeded: boolean;
  spendExceeded: boolean;
}

/** ¿El negocio llegó a alguno de sus topes del mes? (comparación en enteros) */
export function capStatus(limits: AiLimits, usage: Pick<AiUsageSnapshot, "conversationsStarted" | "costMicros">): CapStatus {
  return {
    conversationsExceeded: limits.monthlyConversations !== null && usage.conversationsStarted > limits.monthlyConversations,
    spendExceeded: limits.monthlySpendMicros !== null && usage.costMicros >= limits.monthlySpendMicros,
  };
}

// ── 1. Ingesta por negocio ───────────────────────────────────────────────────

const INGEST_BURST = () => intFromEnv("WHATSAPP_INGEST_BURST", 20);
const INGEST_PER_SEC = () => numberFromEnv("WHATSAPP_INGEST_PER_SEC", 1);
/** Cuánto se difiere el job de un mensaje que pasó el límite de ingesta. */
export const INGEST_DEFER_MS = intFromEnv("WHATSAPP_INGEST_DEFER_SEC", 5) * 1000;

interface Bucket {
  tokens: number;
  refilledAt: number;
}
const buckets = new Map<string, Bucket>();
const BUCKET_IDLE_MS = 20 * 60_000;

/** Consume un token del negocio. false = se pasó (el llamador difiere el job; nunca descarta). */
export function allowIngest(businessId: string, now: number = Date.now()): boolean {
  const capacity = INGEST_BURST();
  const perSec = INGEST_PER_SEC();
  if (capacity === 0) return true; // 0 = freno desactivado
  let b = buckets.get(businessId);
  if (!b) {
    b = { tokens: capacity, refilledAt: now };
    buckets.set(businessId, b);
  }
  b.tokens = Math.min(capacity, b.tokens + (Math.max(0, now - b.refilledAt) / 1000) * perSec);
  b.refilledAt = now;
  // Purga perezosa: un proceso de vida larga no acumula baldes de negocios inactivos.
  if (buckets.size > 1000) {
    for (const [id, other] of buckets) if (now - other.refilledAt > BUCKET_IDLE_MS) buckets.delete(id);
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Solo para tests. */
export function _resetIngestBucketsForTests(): void {
  buckets.clear();
}

// ── 2. Por cliente final ─────────────────────────────────────────────────────

/** Turnos del agente por cliente por hora (0 = sin freno). */
export function clientTurnsPerHour(): number {
  return intFromEnv("WHATSAPP_CLIENT_TURNS_PER_HOUR", 30);
}

/** Ventana (minutos) en la que se buscan mensajes repetidos. */
export function loopWindowMin(): number {
  return Math.max(1, intFromEnv("WHATSAPP_LOOP_WINDOW_MIN", 10));
}

/**
 * Repeticiones del mismo texto para tratarlo como bucle (0 = desactivado). Piso de 4: una
 * ráfaga humana normal ("hola" "hola" "hola") nunca pausa el bot.
 */
export function loopRepeats(): number {
  const n = intFromEnv("WHATSAPP_LOOP_REPEATS", 5);
  return n === 0 ? 0 : Math.max(4, n);
}

/** Normaliza para comparar repeticiones: sin tildes, minúsculas y números → "#" (tickets, horas). */
export function normalizeForLoop(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿Los mensajes del cliente de la ventana parecen un bucle con otro bot? Los marcadores
 * de multimedia ("[foto]", "[audio]"…) no cuentan: diez fotos seguidas son uso normal.
 */
export function detectLoop(inbound: readonly { content: string }[], minRepeats: number): { repeats: number } | null {
  if (minRepeats <= 0) return null;
  const counts = new Map<string, number>();
  for (const m of inbound) {
    if (m.content.trim().startsWith("[")) continue;
    const key = normalizeForLoop(m.content);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let worst = 0;
  for (const n of counts.values()) worst = Math.max(worst, n);
  return worst >= minRepeats ? { repeats: worst } : null;
}

/** Prefijo del `wa_message_id` sintético del aviso de límite (los de Meta empiezan con "wamid."). */
export const CLIENT_LIMIT_NOTICE_PREFIX = "client-limit:";
