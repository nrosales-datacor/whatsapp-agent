import {
  CANCEL_APPOINTMENT_PREFIX,
  CONFIRM_APPOINTMENT_PREFIX,
  FOLLOW_UP_ANSWERS,
  FOLLOW_UP_PREFIX,
  MARKETING_CONSENT_PREFIX,
  type FollowUpAnswer,
  type InboundMessage,
} from "./payload";

// ─────────────────────────────────────────────────────────────────────────────
// Acciones directas: mensajes que el pipeline atiende SIN pasar por el agente de IA y que
// nunca ceden en una ráfaga (tienen efecto propio). Portado de
// legacy/src/whatsapp/traspasoHumano.ts (pedir una persona),
// legacy/src/campaigns/consentimiento.ts (BAJA) y del protocolo de botones del
// recordatorio (confirmar / cancelar la cita).
// ─────────────────────────────────────────────────────────────────────────────

/** minúsculas, sin tildes, solo letras/dígitos separados por un espacio. */
export function normalizeCommand(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

// ── Pedir una persona ────────────────────────────────────────────────────────
// Solo con un pedido EXPLÍCITO ("agente", "quiero hablar con una persona", "pasame con un
// asesor"): "¿cuánto cuesta por persona?" no dispara. Los pedidos sutiles los cubre el
// propio agente (acción `handoff`).

const NOUN = "(?:agente|humano|humana|persona|asesor|asesora|operador|operadora|encargado|encargada|alguien)";
const ONLY_REQUEST = new RegExp(
  `^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches)\\s+)?(?:un |una |el |la )?` +
    `(?:agente|humano|humana|persona|asesor|asesora|operador|operadora|agent|human)(?: real)?` +
    `(?:\\s+(?:por favor|porfa|porfis|please|pls))?$`,
);
const CONTACT_VERB = new RegExp(
  `\\b(?:hablar|hablo|habla|comunicar|comunicarme|comunicarse|comunicame|comuniqueme|comunican|` +
    `comunicas|comunica|pasar|pasarme|pasame|paseme|pasas|pase|pasan|pasen|pasenme|contactar|contactarme|` +
    `atienda|atiendan|atenderme)\\b` +
    `(?:\\s+\\S+){0,3}?\\s+(?:con|a|un|una|algun|alguna)(?:\\s+(?:un|una|el|la|algun|alguna))?\\s+${NOUN}\\b`,
);
const I_WANT_ONE = new RegExp(
  `\\b(?:quiero|necesito|prefiero|pido)\\s+(?:a\\s+)?(?:un|una)\\s+(?:agente|humano|humana|persona|asesor|asesora|operador|operadora)\\b`,
);
const ENGLISH = /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a|an|the|some)?\s*(?:human|agent|person|someone|representative)\b/;

/** true si el cliente pidió de forma explícita hablar con una persona. */
export function requestsHuman(text: string): boolean {
  const t = normalizeCommand(text);
  if (!t) return false;
  return ONLY_REQUEST.test(t) || CONTACT_VERB.test(t) || I_WANT_ONE.test(t) || ENGLISH.test(t);
}

// ── BAJA de promociones ──────────────────────────────────────────────────────
// El mensaje COMPLETO tiene que ser el pedido ("baja", "STOP.", "no quiero más
// promociones"), con saludo o cortesía alrededor; "quiero cancelar mi cita" no es baja.

const PREFIX = "(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|ok|okay|ya)\\s+)*";
const SUFFIX = "(?:\\s+(?:por favor|porfa|porfis|please|pls|gracias|ya))*";
const WHAT = "(?:promociones|promocion|promos|promo|publicidad|ofertas|anuncios|campanas|mensajes|novedades)";
const OPT_OUT_PATTERNS: RegExp[] = [
  /^(?:baja|stop|unsubscribe|desuscribir|desuscribirme|desuscribanme|desinscribirme)$/,
  /^(?:quiero\s+)?(?:darme|dar|dame|denme|me\s+doy)\s+de\s+baja$/,
  /^(?:quiero\s+)?(?:cancelar|anular)\s+(?:mi\s+|la\s+)?suscripcion$/,
  new RegExp(`^(?:ya\\s+)?no\\s+(?:quiero|deseo|necesito)\\s+(?:recibir\\s+)?(?:mas\\s+)?${WHAT}(?:\\s+de\\s+ustedes)?$`),
  new RegExp(`^(?:ya\\s+)?no\\s+(?:me\\s+)?(?:manden|mande|envien|envie|escriban|sigan\\s+mandando|sigan\\s+enviando)\\s+mas(?:\\s+${WHAT})?$`),
  new RegExp(`^(?:quiero\\s+)?dejar\\s+de\\s+recibir\\s+${WHAT}$`),
];
const MAX_OPT_OUT_LENGTH = 60;

/** true si el mensaje COMPLETO es un pedido de baja de promociones. */
export function isOptOutRequest(text: string): boolean {
  const t = normalizeCommand(text).replace(/ñ/g, "n");
  if (!t || t.length > MAX_OPT_OUT_LENGTH) return false;
  const core = t.replace(new RegExp(`^${PREFIX}`), "").replace(new RegExp(`${SUFFIX}$`), "").trim();
  return core !== "" && OPT_OUT_PATTERNS.some((re) => re.test(core));
}

// ── Confirmar / cancelar la cita desde el recordatorio ───────────────────────

export interface AppointmentReply {
  action: "confirm" | "cancel";
  /** La cita del botón; null si el botón de la plantilla no trajo nuestro payload (se usa la próxima del cliente). */
  appointmentId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRM_WORDS = new Set(["confirmo", "confirmar", "si confirmo", "confirmado", "confirmada"]);
const CANCEL_WORDS = new Set(["cancelar", "cancelo", "cancelar cita", "cancelar mi cita"]);

/** El cliente tocó "Confirmo"/"Cancelar" en un recordatorio (botón nativo o de plantilla). */
export function appointmentReplyOf(message: Pick<InboundMessage, "interactiveId" | "buttonText">): AppointmentReply | null {
  const [kind, arg] = (message.interactiveId ?? "").split("|");
  if ((kind === CONFIRM_APPOINTMENT_PREFIX || kind === CANCEL_APPOINTMENT_PREFIX) && arg && UUID.test(arg)) {
    return { action: kind === CONFIRM_APPOINTMENT_PREFIX ? "confirm" : "cancel", appointmentId: arg.toLowerCase() };
  }
  // Botón de una plantilla configurada sin nuestro payload: se reconoce por su texto.
  if (message.buttonText) {
    const t = normalizeCommand(message.buttonText);
    if (CONFIRM_WORDS.has(t)) return { action: "confirm", appointmentId: null };
    if (CANCEL_WORDS.has(t)) return { action: "cancel", appointmentId: null };
  }
  return null;
}

// ── Consentimiento de promociones y seguimiento post-servicio (I6) ───────────
// Solo por botón (nuestro payload): un "sí" escrito a mano es ambiguo y lo atiende el agente.

/** El cliente respondió "¿te avisamos de promociones?": true = sí, false = no. null si no es eso. */
export function marketingConsentReplyOf(message: Pick<InboundMessage, "interactiveId">): boolean | null {
  const [kind, arg] = (message.interactiveId ?? "").split("|");
  if (kind !== MARKETING_CONSENT_PREFIX) return null;
  if (arg === "yes") return true;
  if (arg === "no") return false;
  return null;
}

export interface FollowUpReply {
  appointmentId: string;
  answer: FollowUpAnswer;
}

/** El cliente respondió el seguimiento post-servicio de una cita (Excelente / Bien / Mal). */
export function followUpReplyOf(message: Pick<InboundMessage, "interactiveId">): FollowUpReply | null {
  const [kind, appointmentId, answer] = (message.interactiveId ?? "").split("|");
  if (kind !== FOLLOW_UP_PREFIX || !appointmentId || !UUID.test(appointmentId)) return null;
  if (!(FOLLOW_UP_ANSWERS as readonly string[]).includes(answer)) return null;
  return { appointmentId: appointmentId.toLowerCase(), answer: answer as FollowUpAnswer };
}

export type DirectAction = "appointment_reply" | "opt_out" | "human_request" | "marketing_consent" | "follow_up_reply";

/** Acción directa de un mensaje de texto, o null si es un turno para el agente. */
export function directActionOf(message: Pick<InboundMessage, "kind" | "text" | "interactiveId" | "buttonText">): DirectAction | null {
  if (message.kind !== "text") return null;
  if (appointmentReplyOf(message)) return "appointment_reply";
  if (marketingConsentReplyOf(message) !== null) return "marketing_consent";
  if (followUpReplyOf(message)) return "follow_up_reply";
  if (isOptOutRequest(message.text)) return "opt_out";
  if (requestsHuman(message.text)) return "human_request";
  return null;
}
