import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDUSTRIES, loadIndustryTemplate, type Industry } from "../src/modules/business";
import { AI_REGISTERS, type AiRegister } from "../src/modules/whatsapp/schema";
import type { AgentAction, AgentReply } from "../src/modules/whatsapp/agentContract";
import { TOOL_NAMES } from "../src/modules/whatsapp/agent";
import { isOutOfScopeReply } from "../src/modules/whatsapp/agent/texts";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos, carga de casos y ASERCIONES de las evals del agente (puerto de
// legacy/eval/aserciones.ts). Vive aparte de `runEval.ts` a propósito: ese archivo llama a
// OpenAI real (sin OPENAI_API_KEY se salta); acá está la lógica pura, cubierta por
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
  /** NO debe haber una acción de este tipo (p. ej. que no quede ninguna cita agendada). */
  notAction?: AgentAction["type"];
  /** La respuesta debe contener TODOS estos textos (sin distinguir mayúsculas). */
  contains?: string[];
  /** La respuesta debe contener AL MENOS UNO. */
  containsAny?: string[];
  /** Por CADA grupo, la respuesta contiene al menos uno de sus textos (varios `containsAny` a la vez). */
  containsEach?: string[][];
  /** La respuesta NO debe contener ninguno. */
  notContains?: string[];
  /** Toda tool con argumento `date` usa el año en curso (no inventa años). */
  currentYearDates?: boolean;
  /** La respuesta no menciona NINGÚN monto (no inventa precios). */
  noAmount?: boolean;
  /**
   * Con `noAmount`: montos REALES del catálogo que sí puede mencionar (p. ej. el precio de
   * la valoración al explicar que el tratamiento se cotiza ahí). Se quitan antes de buscar montos.
   */
  allowedAmounts?: string[];
  /** Una llamada a `tool` con estos argumentos (comparados como texto / JSON). */
  argIncludes?: { tool: string; args: Record<string, ExpectedArg> };
}

/** Regla de upsell de un caso, por NOMBRE de servicio (se resuelve a ids al sembrar). */
export interface EvalUpsellRule {
  /** A quien agenda este servicio… */
  service: string;
  /** …se le ofrece agregar este. */
  suggest: string;
}

export interface EvalCase {
  name: string;
  description?: string;
  /**
   * Caso crítico ("no inventa precios", "no agenda fuera de horario"): exige el 100 % de
   * las repeticiones en verde, no la tasa mínima general (`EVAL_MIN_PASS_RATE`).
   */
  critical?: boolean;
  /**
   * Plantilla de rubro del negocio. "aesthetics" (default): el negocio demo de `seed:dev`
   * (dos sucursales, precios y agenda de la semana). Otra: un negocio nuevo de ese rubro
   * creado como un alta real, con una sola sucursal "Escazú" y precios de demo (eval/world.ts).
   */
  template?: Industry;
  /** Registro del agente (vos / tu / usted). Sin el campo, el de la plantilla. */
  register?: AiRegister;
  /** Crecimiento (I6) activo en el turno. Sin el campo: ni cotizaciones ni upsell. */
  growth?: { quoteRecovery?: boolean; upsell?: EvalUpsellRule[] };
  /** "single" (default): el número atiende Escazú. "all": atiende todas las sucursales. */
  channel?: "single" | "all";
  /**
   * Turnos previos (de hoy, en orden). `byHuman` en un mensaje del asistente = lo escribió
   * una persona del equipo desde la bandeja (el agente lo ve con una nota aparte).
   */
  history?: { role: "user" | "assistant"; text: string; byHuman?: boolean }[];
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
  if (expect.notAction && result.actions.some((a) => a.type === expect.notAction)) failures.push(`NO esperaba la acción "${expect.notAction}", pero ocurrió`);

  for (const s of expect.contains ?? []) if (!lower.includes(s.toLowerCase())) failures.push(`la respuesta no contiene "${s}"`);
  if (expect.containsAny && !expect.containsAny.some((s) => lower.includes(s.toLowerCase()))) {
    failures.push(`la respuesta no menciona ninguno de: ${expect.containsAny.join(", ")}`);
  }
  for (const group of expect.containsEach ?? []) {
    if (!group.some((s) => lower.includes(s.toLowerCase()))) failures.push(`la respuesta no menciona ninguno de: ${group.join(", ")}`);
  }
  for (const s of expect.notContains ?? []) if (lower.includes(s.toLowerCase())) failures.push(`la respuesta no debería contener "${s}"`);

  if (expect.noAmount) {
    const checked = (expect.allowedAmounts ?? []).reduce((t, amount) => t.split(amount).join(" "), text);
    const pattern = AMOUNT_PATTERNS.find((p) => p.test(checked));
    if (pattern) failures.push(`la respuesta menciona un monto ("${checked.match(pattern)?.[0]?.trim()}") y no debería`);
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

/** Servicios que menciona un caso (placeholders, citas sembradas y upsell), para validar que existan en el seed. */
export function mentionedServices(c: EvalCase): string[] {
  const fromArgs = Object.values(c.expect.argIncludes?.args ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string" && v.startsWith(SERVICE_PLACEHOLDER))
    .map((v) => v.slice(SERVICE_PLACEHOLDER.length));
  const fromUpsell = (c.growth?.upsell ?? []).flatMap((r) => [r.service, r.suggest]);
  return [...fromArgs, ...(c.seedAppointments ?? []).map((s) => s.service), ...fromUpsell];
}

/** Plantilla de rubro del caso (default: estética, el negocio de `seed:dev`). */
export function caseTemplate(c: EvalCase): Industry {
  return c.template ?? "aesthetics";
}

const GROWTH_TOOLS: Record<string, "quote" | "upsell"> = { record_quote: "quote", add_service_to_appointment: "upsell", decline_upsell: "upsell" };

/**
 * Errores de forma de un caso (vacío = válido): nombre y mensaje, plantilla y registro
 * existentes, tools reales (y las de crecimiento solo con su `growth` activo), servicios de
 * la plantilla elegida y `byHuman` solo en mensajes del asistente. Lo usan el test del
 * arnés y `runEval` antes de gastar tokens: un typo no puede leerse como "el agente falló".
 */
export function validateCase(c: EvalCase): string[] {
  const errors: string[] = [];
  const label = c?.name || "(sin nombre)";
  if (!c?.name?.trim()) errors.push("el caso no tiene nombre");
  if (!c?.user?.trim()) errors.push(`${label}: falta el mensaje del cliente ("user")`);
  if (!c?.expect || typeof c.expect !== "object") return [...errors, `${label}: falta "expect"`];
  if (c.template !== undefined && !INDUSTRIES.includes(c.template)) errors.push(`${label}: la plantilla "${c.template}" no existe`);
  if (c.register !== undefined && !AI_REGISTERS.includes(c.register)) errors.push(`${label}: el registro "${c.register}" no existe`);
  for (const t of mentionedTools(c.expect)) {
    if (!TOOL_NAMES.includes(t)) errors.push(`${label}: la tool "${t}" no existe`);
    // Que se espere usar una tool de crecimiento sin activarla haría fallar el caso por el arnés.
    const kind = GROWTH_TOOLS[t];
    const required = t === c.expect.tool || t === c.expect.argIncludes?.tool || (c.expect.anyTool ?? []).includes(t);
    if (required && kind === "quote" && !c.growth?.quoteRecovery) errors.push(`${label}: espera "${t}" sin "growth.quoteRecovery"`);
    if (required && kind === "upsell" && !c.growth?.upsell?.length) errors.push(`${label}: espera "${t}" sin reglas en "growth.upsell"`);
  }
  if (c.template === undefined || INDUSTRIES.includes(c.template)) {
    const template = caseTemplate(c);
    const catalog = loadIndustryTemplate(template).catalog.categories.flatMap((cat) => cat.services);
    for (const name of mentionedServices(c)) {
      const service = catalog.find((s) => s.name === name);
      if (!service) errors.push(`${label}: el servicio "${name}" no está en la plantilla "${template}"`);
      // El agente solo ve lo que se agenda en línea: con otro, ni el mejor modelo pasa el caso.
      else if (service.onlineBooking === false) errors.push(`${label}: el servicio "${name}" no se agenda en línea (el agente no lo ve)`);
    }
  }
  for (const m of c.history ?? []) {
    if (m.role !== "user" && m.role !== "assistant") errors.push(`${label}: rol de historial inválido "${String(m.role)}"`);
    if (m.byHuman && m.role !== "assistant") errors.push(`${label}: "byHuman" solo va en mensajes del asistente`);
  }
  if (c.channel === "all" && caseTemplate(c) !== "aesthetics") errors.push(`${label}: "channel: all" solo tiene sentido con el negocio de dos sucursales (estética)`);
  return errors;
}
