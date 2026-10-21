import type { AiRegister } from "../schema";

// ─────────────────────────────────────────────────────────────────────────────
// Textos FIJOS que el agente le manda al cliente final sin pasar por el LLM (puerto de
// legacy/src/config/textos.ts, E11): la confirmación de lo que ya quedó guardado cuando el
// turno no termina en una respuesta del modelo, el aviso de traspaso a una persona y los
// respaldos cuando el modelo no devuelve texto.
//
//   1. Cada texto tiene una plantilla por REGISTRO (vos / tú / usted): el mismo registro
//      que usa el prompt (ai_settings.register), así el modelo y los textos fijos tratan
//      al cliente igual.
//   2. Override por negocio: `ai_settings.texts[clave]` reemplaza la plantilla entera, con
//      las mismas variables `{servicio}`… (sirve también para un negocio que atiende en
//      otro idioma).
//
// Las claves son estables: son también las claves del override guardado. Agregar es
// libre; renombrar rompe los overrides de los negocios.
// ─────────────────────────────────────────────────────────────────────────────

type ByRegister = Record<AiRegister, string>;

export const AGENT_TEXTS = {
  /** El agente pasa la conversación a una persona del equipo. */
  handoff: {
    vos: "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.",
    tu: "Déjame consultarlo con una persona del equipo 🙋 En un momento te responden por aquí.",
    usted: "Permítame consultarlo con una persona del equipo 🙋 En un momento le responden por aquí.",
  },
  /** El modelo devolvió un mensaje vacío. */
  notUnderstood: {
    vos: "Disculpá, no entendí. ¿Me lo repetís?",
    tu: "Disculpa, no entendí. ¿Me lo repites?",
    usted: "Disculpe, no entendí. ¿Me lo repite?",
  },
  /** Ejemplo de respuesta "fuera de alcance" que el prompt le da al modelo. Vars: {business}. */
  outOfScope: {
    vos: "Disculpá, solo puedo ayudarte con cosas de {business} 🙂 ¿En qué te puedo ayudar?",
    tu: "Disculpa, solo puedo ayudarte con cosas de {business} 🙂 ¿En qué te puedo ayudar?",
    usted: "Disculpe, solo puedo ayudarle con cosas de {business} 🙂 ¿En qué le puedo ayudar?",
  },
  /** Respaldo cuando hay botones de horarios pero el modelo no escribió el texto. */
  pickSlot: {
    vos: "Estos son los horarios que tengo 👇 ¿Cuál te sirve?",
    tu: "Estos son los horarios que tengo 👇 ¿Cuál te sirve?",
    usted: "Estos son los horarios que tengo 👇 ¿Cuál le sirve?",
  },
  /** Confirmación fija de una reserva ya guardada. Vars: {services} {date} {time} {location}. */
  appointmentBooked: {
    vos: "✅ Tu {appointment} quedó agendada: {services}, {date} a las {time} en {location}.",
    tu: "✅ Tu {appointment} quedó agendada: {services}, {date} a las {time} en {location}.",
    usted: "✅ Su {appointment} quedó agendada: {services}, {date} a las {time} en {location}.",
  },
  /** Vars: {services} {date} {time} {location}. */
  appointmentRescheduled: {
    vos: "✅ Tu {appointment} quedó cambiada: {services}, {date} a las {time} en {location}.",
    tu: "✅ Tu {appointment} quedó cambiada: {services}, {date} a las {time} en {location}.",
    usted: "✅ Su {appointment} quedó cambiada: {services}, {date} a las {time} en {location}.",
  },
  /** Vars: {services} {date}. */
  appointmentCancelled: {
    vos: "Tu {appointment} de {services} del {date} quedó cancelada.",
    tu: "Tu {appointment} de {services} del {date} quedó cancelada.",
    usted: "Su {appointment} de {services} del {date} quedó cancelada.",
  },
} satisfies Record<string, ByRegister>;

export type AgentTextKey = keyof typeof AGENT_TEXTS;

/** Claves del catálogo del agente (también válidas como override en ai_settings.texts). */
export const AGENT_TEXT_KEYS = Object.keys(AGENT_TEXTS) as AgentTextKey[];

/** Reemplaza `{variable}` por su valor; las desconocidas quedan tal cual. */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
}

/**
 * Texto fijo para el cliente final: el override del negocio si lo tiene; si no, la
 * plantilla de su registro, con las variables reemplazadas.
 */
export function agentText(
  settings: { register: AiRegister; texts: Readonly<Record<string, string>> },
  key: AgentTextKey,
  vars: Record<string, string | number> = {},
): string {
  // `typeof`: el JSONB viene de la base y un valor raro no debe tumbar el envío.
  const raw: unknown = settings.texts[key];
  const override = typeof raw === "string" ? raw.trim() : "";
  return interpolate(override || AGENT_TEXTS[key][settings.register], vars);
}

/**
 * ¿La respuesta es la deflección de "fuera de alcance"? Acepta las variantes por registro
 * e idioma (la usan las métricas y las evals; un falso negativo no cambia lo que recibe
 * el cliente).
 */
export function isOutOfScopeReply(reply: string): boolean {
  return (
    /solo\s+(?:te\s+|le\s+|lo\s+|la\s+)?puedo\s+ayudar(?:te|le|lo|la)?\s+(?:con|en)\b/i.test(reply) ||
    /\bI\s+can\s+only\s+help\b/i.test(reply) ||
    /s[óo]\s+posso\s+ajudar/i.test(reply)
  );
}
