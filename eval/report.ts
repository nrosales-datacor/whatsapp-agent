import type { EvalCase } from "./assertions";

// ─────────────────────────────────────────────────────────────────────────────
// Umbral, tope de gasto y reporte de una corrida de evals (lógica pura, cubierta por
// test/unit/evalHarness.test.ts; runEval.ts solo la usa).
//
//   • Umbral: un caso pasa si su tasa de acierto (verdes / repeticiones) llega a
//     `EVAL_MIN_PASS_RATE` (default 0,9). Los casos `critical` ("no inventa precios", "no
//     agenda fuera de horario") exigen el 100 %. Ojo: con `EVAL_REPEAT=3`, 0,9 significa
//     3 de 3 (2/3 = 0,67); el 90 % recién deja margen desde 10 repeticiones (9/10).
//   • Tope de gasto: `EVAL_MAX_COST_USD` (default 1). La corrida se corta ENTRE turnos al
//     alcanzarlo (un turno de más cuesta centavos): los casos que faltan quedan "sin correr"
//     y la corrida no cuenta como completa (no sirve de línea base).
//   • Reporte JSON (eval/results/<fecha>-<modelo>.json y, a pedido, eval/baseline.json):
//     modelo, fecha, umbral, costo y, por caso, repeticiones, verdes, tasa y los motivos de
//     fallo. SIN las respuestas del agente ni datos del cliente: solo los motivos que
//     escriben las aserciones (que nombran tools, horas y textos esperados).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MIN_PASS_RATE = 0.9;
/** Tasa exigida a los casos críticos (decisión del usuario, 2026-10-31). */
export const CRITICAL_PASS_RATE = 1;
export const DEFAULT_MAX_COST_USD = 1;
/** Versión del formato del JSON de resultados. */
export const REPORT_VERSION = 1;

/** Número de una env ("0.9" o "0,9"); `fallback` si falta; error legible si no es válido. */
function envNumber(name: string, raw: string | undefined, fallback: number, valid: (n: number) => boolean, hint: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(n) || !valid(n)) throw new Error(`${name}="${raw}" no es válido: ${hint}`);
  return n;
}

/** `EVAL_MIN_PASS_RATE`: fracción entre 0 y 1 (p. ej. 0.9). */
export function parseMinPassRate(raw: string | undefined): number {
  return envNumber("EVAL_MIN_PASS_RATE", raw, DEFAULT_MIN_PASS_RATE, (n) => n > 0 && n <= 1, "una fracción mayor que 0 y hasta 1 (p. ej. 0.9)");
}

/** `EVAL_MAX_COST_USD`: dólares por corrida, mayor que 0. */
export function parseMaxCostUsd(raw: string | undefined): number {
  return envNumber("EVAL_MAX_COST_USD", raw, DEFAULT_MAX_COST_USD, (n) => n > 0, "un monto en dólares mayor que 0 (p. ej. 1 o 0.5)");
}

/** `EVAL_REPEAT`: entero ≥ 1 (default 1). */
export function parseRepeat(raw: string | undefined): number {
  return envNumber("EVAL_REPEAT", raw, 1, (n) => Number.isInteger(n) && n >= 1 && n <= 50, "un entero entre 1 y 50");
}

/** Tasa que tiene que alcanzar un caso. */
export function requiredRate(c: Pick<EvalCase, "critical">, minPassRate: number): number {
  return c.critical ? CRITICAL_PASS_RATE : minPassRate;
}

/** Lo que pasó con un caso en la corrida. */
export interface CaseOutcome {
  name: string;
  critical: boolean;
  /** Repeticiones corridas (0 = el tope de gasto cortó antes). */
  runs: number;
  passed: number;
  /** Motivos de fallo distintos (sin la respuesta del agente). */
  failures: string[];
}

export interface CaseResult extends CaseOutcome {
  passRate: number | null;
  required: number;
  /** null = no se corrió. */
  ok: boolean | null;
}

/** Prefijo de la línea que `EVAL_VERBOSE` agrega con la respuesta del agente (solo consola). */
export const VERBOSE_REPLY_PREFIX = "respuesta: ";

/** Motivos de fallo que van al reporte: sin las líneas de `EVAL_VERBOSE` (traen la respuesta). */
export function reportableFailures(failures: string[]): string[] {
  return [...new Set(failures.filter((f) => !f.startsWith(VERBOSE_REPLY_PREFIX)))];
}

export function caseResult(o: CaseOutcome, minPassRate: number): CaseResult {
  const required = requiredRate(o, minPassRate);
  if (o.runs === 0) return { ...o, passRate: null, required, ok: null };
  const passRate = o.passed / o.runs;
  // Tolerancia de punto flotante (9/10 contra 0.9).
  return { ...o, passRate, required, ok: passRate + 1e-9 >= required };
}

/** ✅ todas verdes · 🟡 alguna roja pero sobre el umbral · ❌ bajo el umbral · ⏭️ sin correr. */
export function caseIcon(r: CaseResult): string {
  if (r.ok === null) return "⏭️ ";
  if (r.passed === r.runs) return "✅";
  return r.ok ? "🟡" : "❌";
}

export interface RunReport {
  version: number;
  /** ISO de cuando terminó la corrida. */
  date: string;
  model: string;
  repeat: number;
  minPassRate: number;
  criticalPassRate: number;
  /** Filtro `EVAL_CASE` (null = todos). */
  filter: string | null;
  /** true = se corrieron todos los casos del filtro sin que cortara el tope de gasto. */
  complete: boolean;
  maxCostUsd: number;
  /** Costo estimado con las tarifas de src/modules/whatsapp/agent/cost.ts. */
  costUsd: number;
  tokens: { input: number; output: number };
  summary: { cases: number; ok: number; belowThreshold: number; notRun: number };
  /** true = ningún caso corrido quedó bajo su umbral y la corrida está completa. */
  passed: boolean;
  cases: CaseResult[];
}

export function buildReport(input: {
  date: Date;
  model: string;
  repeat: number;
  minPassRate: number;
  filter: string | null;
  maxCostUsd: number;
  costMicros: number;
  tokens: { input: number; output: number };
  outcomes: CaseOutcome[];
}): RunReport {
  const cases = input.outcomes.map((o) => caseResult({ ...o, failures: reportableFailures(o.failures) }, input.minPassRate));
  const notRun = cases.filter((c) => c.ok === null).length;
  const belowThreshold = cases.filter((c) => c.ok === false).length;
  return {
    version: REPORT_VERSION,
    date: input.date.toISOString(),
    model: input.model,
    repeat: input.repeat,
    minPassRate: input.minPassRate,
    criticalPassRate: CRITICAL_PASS_RATE,
    filter: input.filter,
    complete: notRun === 0,
    maxCostUsd: input.maxCostUsd,
    costUsd: Math.round(input.costMicros) / 1_000_000,
    tokens: input.tokens,
    summary: { cases: cases.length, ok: cases.filter((c) => c.ok === true).length, belowThreshold, notRun },
    passed: notRun === 0 && belowThreshold === 0,
    cases,
  };
}

/** Nombre del archivo de resultados: "2026-10-31-1530-gpt-4o-mini.json" (hora UTC; sin caracteres raros). */
export function resultFileName(date: Date, model: string): string {
  const stamp = date.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "modelo";
  return `${stamp}-${safeModel}.json`;
}

/**
 * ¿Esta corrida puede guardarse como línea base? Completa (sin cortar por gasto), con
 * todos los casos (sin `EVAL_CASE`) y con al menos 3 repeticiones. Devuelve el motivo si no.
 */
export function baselineRefusal(report: Pick<RunReport, "complete" | "filter" | "repeat">): string | null {
  if (report.filter) return "corrió con EVAL_CASE (no son todos los casos)";
  if (!report.complete) return "el tope de gasto cortó la corrida antes de terminar";
  if (report.repeat < 3) return "necesita EVAL_REPEAT=3 o más para medir una tasa";
  return null;
}

/** "(línea base 3/3)" para comparar un caso con la corrida guardada en eval/baseline.json. */
export function baselineNote(name: string, baseline: Pick<RunReport, "cases"> | null): string {
  const b = baseline?.cases.find((c) => c.name === name);
  if (!b) return baseline ? " (nuevo: no está en la línea base)" : "";
  return b.ok === null ? " (línea base: sin correr)" : ` (línea base ${b.passed}/${b.runs})`;
}

/** Tasa como porcentaje legible ("90 %"). */
export function percent(rate: number): string {
  return `${Math.round(rate * 1000) / 10} %`;
}
