import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAction, AgentReply } from "../src/modules/whatsapp/agentContract";
import { isOutOfScopeReply } from "../src/modules/whatsapp/agent/texts";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos, carga de casos y ASERCIONES de las evals del agente (puerto de
// legacy/eval/aserciones.ts). Vive aparte de `runEval.ts` a propósito: ese archivo llama a
// OpenAI real y exige OPENAI_API_KEY; acá está la lógica pura, cubierta por
// test/unit/evalHarness.test.ts (determinista, corre en `npm test`), para que un bug en
// las aserciones no se disfrace de "el agente falló".
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Valor esperado de un argumento. `"$service:<nombre>"` se resuelve al id del servicio del seed. */
export type ExpectedArg = string | number | string[];

export interface Expectation {
  /** Debe haberse llamado esta tool (al menos una vez). */
  tool?: string;
  /** Debe haberse llamado AL MENOS UNA de estas. */
  anyTool?: string[];
  /** NO debe haberse llamado esta tool. */
  notTool?: string;
  /** No debe haberse llamado ninguna tool. */
  noTools?: boolean;
  /** El turno debe / no debe terminar en traspaso a una persona. */
  handoff?: boolean;
  /** La respuesta debe / no debe ser la deflección de "fuera de alcance". */
  outOfScope?: boolean;
  /** Debe / no debe haber botones (horarios ofrecidos). */
  buttons?: boolean;
  /** Debe haber una acción de este tipo en el resultado. */
  action?: AgentAction["type"];
  /** La respuesta debe contener TODOS estos textos (sin distinguir mayúsculas). */
  contains?: string[];
  /** La respuesta debe contener AL MENOS UNO. */
  containsAny?: string[];
  /** La respuesta NO debe contener ninguno. */
  notContains?: string[];
  /** Toda tool con argumento `date` usa el año en curso (no inventa años). */
  currentYearDates?: boolean;
  /** La respuesta no menciona NINGÚN monto (no inventa precios). */
  noAmount?: boolean;
  /** Una llamada a `tool` con estos argumentos (comparados como texto / JSON). */
  argIncludes?: { tool: string; args: Record<string, ExpectedArg> };
}

export interface EvalCase {
  name: string;
  description?: string;
  /** "single" (default): el número atiende Escazú. "all": atiende todas las sucursales. */
  channel?: "single" | "all";
  /** Turnos previos (de hoy, en orden). */
  history?: { role: "user" | "assistant"; text: string }[];
  /** Citas del cliente a sembrar antes de correr (sucursal Escazú, cualquier especialista). */
  seedAppointments?: { service: string; inDays: number; time: string }[];
  /** Mensaje del cliente en este turno. */
  user: string;
  expect: Expectation;
}

/** Resultado del runner en la forma que miran las aserciones. */
export interface ObservedResult {
  replies: AgentReply[];
  actions: AgentAction[];
}

// Formas de escribir un monto que el agente no debería producir cuando no hay precio.
// Cifras con símbolo o moneda, o magnitudes ("50 mil"); no cualquier número ("30 min",
// "8:00" o "2026" no son montos).
export const AMOUNT_PATTERNS: RegExp[] = [
  /[₡$]\s?\d/,
  /\d[\d.,\s]*\s*(mil|millones?|mill[oó]n)\b/i,
  /\d[\d.,]*\s*(colones|d[oó]lares|usd|crc)\b/i,
  /\b(un|una|dos|tres|cuatro|cinco|medio)\s+mill[oó]n/i,
];

export const SERVICE_PLACEHOLDER = "$service:";

/** Resuelve los `"$service:<nombre>"` de un valor esperado con `serviceId(nombre)`. */
export function resolveExpected(value: ExpectedArg, serviceId: (name: string) => string): ExpectedArg {
  const one = (v: string) => (v.startsWith(SERVICE_PLACEHOLDER) ? serviceId(v.slice(SERVICE_PLACEHOLDER.length)) : v);
  if (Array.isArray(value)) return value.map(one);
  return typeof value === "string" ? one(value) : value;
}

const asText = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : JSON.stringify(v));

/**
 * Aplica las aserciones de un caso y devuelve los fallos (vacío = verde). `currentYear` se
 * pasa explícito para poder probarlo sin depender del reloj.
 */
export function evaluate(
  expect: Expectation,
  result: ObservedResult,
  tools: ObservedToolCall[],
  currentYear: string,
  serviceId: (name: string) => string = (n) => n,
): string[] {
  const failures: string[] = [];
  const names = tools.map((t) => t.name);
  const used = names.length ? names.join(", ") : "(ninguna)";
  const text = result.replies.map((r) => r.text).join("\n");
  const lower = text.toLowerCase();
  const handedOff = result.actions.some((a) => a.type === "handoff");
  const hasButtons = result.replies.some((r) => (r.buttons?.length ?? 0) > 0);

  if (expect.tool && !names.includes(expect.tool)) failures.push(`esperaba la tool "${expect.tool}"; se usaron: ${used}`);
  if (expect.anyTool && !expect.anyTool.some((t) => names.includes(t))) failures.push(`esperaba alguna de [${expect.anyTool.join(", ")}]; se usaron: ${used}`);
  if (expect.notTool && names.includes(expect.notTool)) failures.push(`NO esperaba la tool "${expect.notTool}", pero se usó`);
  if (expect.noTools && names.length) failures.push(`no esperaba tools, pero se usaron: ${used}`);

  if (expect.handoff === true && !handedOff) failures.push("esperaba que pasara a una persona, no lo hizo");
  if (expect.handoff === false && handedOff) failures.push("NO esperaba traspaso, pero pasó a una persona");
  if (expect.outOfScope !== undefined && isOutOfScopeReply(text) !== expect.outOfScope) {
    failures.push(expect.outOfScope ? "esperaba la deflección de fuera de alcance" : "NO esperaba la deflección de fuera de alcance");
  }
  if (expect.buttons === true && !hasButtons) failures.push("esperaba botones de horarios, no hubo");
  if (expect.buttons === false && hasButtons) failures.push("NO esperaba botones, pero hubo");
  if (expect.action && !result.actions.some((a) => a.type === expect.action)) {
    failures.push(`esperaba la acción "${expect.action}"; hubo: ${result.actions.map((a) => a.type).join(", ") || "(ninguna)"}`);
  }

  for (const s of expect.contains ?? []) if (!lower.includes(s.toLowerCase())) failures.push(`la respuesta no contiene "${s}"`);
  if (expect.containsAny && !expect.containsAny.some((s) => lower.includes(s.toLowerCase()))) {
    failures.push(`la respuesta no menciona ninguno de: ${expect.containsAny.join(", ")}`);
  }
  for (const s of expect.notContains ?? []) if (lower.includes(s.toLowerCase())) failures.push(`la respuesta no debería contener "${s}"`);

  if (expect.noAmount) {
    const pattern = AMOUNT_PATTERNS.find((p) => p.test(text));
    if (pattern) failures.push(`la respuesta menciona un monto ("${text.match(pattern)?.[0]?.trim()}") y no debería`);
  }

  if (expect.argIncludes) {
    const { tool, args } = expect.argIncludes;
    const calls = tools.filter((t) => t.name === tool);
    if (!calls.length) {
      failures.push(`esperaba la tool "${tool}" (para revisar sus argumentos); se usaron: ${used}`);
    } else {
      const wanted = Object.entries(args).map(([k, v]) => [k, resolveExpected(v, serviceId)] as const);
      const match = calls.some((c) => wanted.every(([k, v]) => asText(c.args[k]) === asText(v)));
      if (!match) failures.push(`"${tool}" no se llamó con ${JSON.stringify(Object.fromEntries(wanted))}; se llamó con: ${calls.map((c) => JSON.stringify(c.args)).join(" | ")}`);
    }
  }

  if (expect.currentYearDates) {
    for (const t of tools) {
      const date = t.args.date;
      if (typeof date === "string" && /^\d{4}-/.test(date) && !date.startsWith(currentYear)) {
        failures.push(`la tool "${t.name}" usó una fecha con año inválido: ${date} (año actual: ${currentYear})`);
      }
    }
  }
  return failures;
}

/** Carga los casos de eval/transcripts/*.json, ordenados por nombre de archivo. */
export function loadCases(): EvalCase[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "transcripts");
  const cases: EvalCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const content: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const c of Array.isArray(content) ? content : [content]) cases.push(c as EvalCase);
  }
  return cases;
}

/** Tools que menciona un caso (para validar que existan). */
export function mentionedTools(expect: Expectation): string[] {
  return [expect.tool, expect.notTool, ...(expect.anyTool ?? []), expect.argIncludes?.tool].filter((n): n is string => typeof n === "string");
}

/** Servicios que menciona un caso (placeholders y citas sembradas), para validar que existan en el seed. */
export function mentionedServices(c: EvalCase): string[] {
  const fromArgs = Object.values(c.expect.argIncludes?.args ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string" && v.startsWith(SERVICE_PLACEHOLDER))
    .map((v) => v.slice(SERVICE_PLACEHOLDER.length));
  return [...fromArgs, ...(c.seedAppointments ?? []).map((s) => s.service)];
}
