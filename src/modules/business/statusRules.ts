import { z } from "zod";
import { AT_RISK_MODES, DEFAULT_CLIENT_STATUS_RULES, type ClientStatusRules } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Forma de las reglas del estado del cliente (PLAN-GESTION.md §4, "umbrales configurables
// por negocio"), sin I/O: Zod para la API y las plantillas, la lectura tolerante de lo
// guardado y lo que se guarda (solo lo que difiere de DEFAULT_CLIENT_STATUS_RULES). La
// usan las plantillas (./templates.ts), el caché del contexto (./context.ts) y
// Configuración › Reglas de clientes (./clientRules.ts). El cálculo del estado vive en
// src/modules/clients/status.ts (dueño de los clientes).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DAYS = 3650;

const RuleFields = {
  newDays: z.int().min(1).max(365),
  vipMinVisits: z.int().min(1).max(10_000).nullable(),
  vipMinSpentCents: z.int().min(0).max(1_000_000_000_000).nullable(),
  atRiskMode: z.enum(AT_RISK_MODES),
  atRiskAfterDays: z.int().min(1).max(MAX_DAYS),
  atRiskFrequencyFactor: z.number().min(1).max(10),
  inactiveAfterDays: z.int().min(1).max(MAX_DAYS),
};

const inactiveAfterAtRisk = (r: Pick<ClientStatusRules, "atRiskAfterDays" | "inactiveAfterDays">) => r.inactiveAfterDays > r.atRiskAfterDays;
const INACTIVE_MESSAGE = "Los días para «inactivo» tienen que ser más que los de «en riesgo».";

/** Reglas parciales (plantillas de rubro y lo guardado): lo que falta sale de los defaults. */
export const ClientStatusRulesOverridesSchema = z
  .object(RuleFields)
  .partial()
  .strict()
  .refine((r) => inactiveAfterAtRisk({ ...DEFAULT_CLIENT_STATUS_RULES, ...r }), { message: INACTIVE_MESSAGE, path: ["inactiveAfterDays"] });

/** Reglas completas (`PUT /settings/client-rules`). */
export const ClientStatusRulesInput = z
  .object({
    ...RuleFields,
    // Un decimal alcanza ("1,5 veces su frecuencia").
    atRiskFrequencyFactor: RuleFields.atRiskFrequencyFactor.transform((n) => Math.round(n * 10) / 10),
  })
  .strict()
  .refine(inactiveAfterAtRisk, { message: INACTIVE_MESSAGE, path: ["inactiveAfterDays"] });

const RULE_KEYS = Object.keys(DEFAULT_CLIENT_STATUS_RULES) as (keyof ClientStatusRules)[];

/**
 * Reglas efectivas desde lo guardado, SIN fallar: una clave desconocida o un valor
 * inválido se ignora (cae al default) en vez de dejar la lista de clientes sin estado por
 * un dato mal cargado. Lo que entra por la API se valida estricto.
 */
export function readClientStatusRules(raw: unknown): ClientStatusRules {
  const out: ClientStatusRules = { ...DEFAULT_CLIENT_STATUS_RULES };
  if (!raw || typeof raw !== "object") return out;
  for (const key of RULE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const parsed = RuleFields[key].safeParse((raw as Record<string, unknown>)[key]);
    if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
  }
  // Un par incoherente (inactivo antes que en riesgo) vuelve a los defaults de esos dos.
  if (!inactiveAfterAtRisk(out)) {
    out.atRiskAfterDays = DEFAULT_CLIENT_STATUS_RULES.atRiskAfterDays;
    out.inactiveAfterDays = Math.max(DEFAULT_CLIENT_STATUS_RULES.inactiveAfterDays, out.atRiskAfterDays + 1);
  }
  return out;
}

/** Lo que se guarda: solo lo que difiere de los defaults globales. */
export function clientStatusRulesOverrides(rules: ClientStatusRules): Partial<ClientStatusRules> {
  const out: Partial<ClientStatusRules> = {};
  for (const key of RULE_KEYS) {
    if (rules[key] !== DEFAULT_CLIENT_STATUS_RULES[key]) (out as Record<string, unknown>)[key] = rules[key];
  }
  return out;
}
