import type { AiRegister } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Textos del PIPELINE al cliente final: lo que se le manda por WhatsApp sin pasar por el
// agente (aviso de bot, traspaso a una persona, disculpas, acuses de botones, BAJA,
// topes, recordatorio). Portado de legacy/src/config/textos.ts.
//
//   1. Cada texto tiene una plantilla por registro (vos / tú / usted): el de
//      `ai_settings.register`, o el que se infiere del país del negocio.
//   2. Override por negocio: `ai_settings.texts[clave]` reemplaza la plantilla entera
//      (mismas variables `{negocio}`…). Las claves son estables: renombrar una rompe los
//      overrides guardados. `PIPELINE_TEXT_KEYS` es la lista válida (la usa la
//      configuración del agente para validar).
//
// Los avisos al OPERADOR (push) y las instrucciones al modelo no viven acá.
// ─────────────────────────────────────────────────────────────────────────────

type ByRegister = Record<AiRegister, string>;

const same = (text: string): ByRegister => ({ vos: text, tu: text, usted: text });

export const PIPELINE_TEXTS = {
  /** Aviso de transparencia del primer mensaje automático. Vars: {negocio}. */
  botNotice: {
    vos: "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.",
    tu: "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribe *agente* si prefieres hablar con una persona.",
    usted:
      "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darle información de servicios, precios y horarios, y agendarle una cita. Escriba *agente* si prefiere hablar con una persona.",
  },
  /** El agente no pudo resolver y pasa el caso a una persona. */
  botHandoff: {
    vos: "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.",
    tu: "Déjame consultarlo con una persona del equipo 🙋 En un momento te responden por aquí.",
    usted: "Permítame consultarlo con una persona del equipo 🙋 En un momento le responden por aquí.",
  },
  /** El cliente pidió explícitamente una persona. */
  humanRequested: {
    vos: "¡Listo! Te paso con una persona del equipo. En un momento te responden por acá. 🙋",
    tu: "¡Listo! Te paso con una persona del equipo. En un momento te responden por aquí. 🙋",
    usted: "¡Listo! Le paso con una persona del equipo. En un momento le responden por aquí. 🙋",
  },
  /** Tope mensual de conversaciones del plan. */
  conversationCapReached: {
    vos: "¡Gracias por escribirnos! 🙌 En un momento te atiende alguien del equipo.",
    tu: "¡Gracias por escribirnos! 🙌 En un momento te atiende alguien del equipo.",
    usted: "¡Gracias por escribirnos! 🙌 En un momento le atiende alguien del equipo.",
  },
  /** Tope mensual de gasto de IA: neutro a propósito. */
  spendCapReached: {
    vos: "¡Gracias por escribirnos! 🙂 En un momento te atiende una persona del equipo por acá.",
    tu: "¡Gracias por escribirnos! 🙂 En un momento te atiende una persona del equipo por aquí.",
    usted: "¡Gracias por escribirnos! 🙂 En un momento le atiende una persona del equipo por aquí.",
  },
  /** Sticker o video. */
  unsupportedMedia: {
    vos: "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Contame por texto (o mandame una foto) en qué te puedo ayudar.",
    tu: "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Cuéntame por texto (o envíame una foto) en qué te puedo ayudar.",
    usted: "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Cuénteme por texto (o envíeme una foto) en qué le puedo ayudar.",
  },
  documentUnsupported: {
    vos: "¡Hola! 🙂 Recibí tu documento, pero todavía no puedo abrirlo. Contame por texto en qué te ayudo y si hace falta alguien del equipo lo revisa.",
    tu: "¡Hola! 🙂 Recibí tu documento, pero todavía no puedo abrirlo. Cuéntame por texto en qué te ayudo y si hace falta alguien del equipo lo revisa.",
    usted: "¡Hola! 🙂 Recibí su documento, pero todavía no puedo abrirlo. Cuénteme por texto en qué le ayudo y si hace falta alguien del equipo lo revisa.",
  },
  contactUnsupported: {
    vos: "¡Hola! 🙂 Recibí el contacto que compartiste, pero todavía no puedo procesarlo. Contame por texto en qué te ayudo.",
    tu: "¡Hola! 🙂 Recibí el contacto que compartiste, pero todavía no puedo procesarlo. Cuéntame por texto en qué te ayudo.",
    usted: "¡Hola! 🙂 Recibí el contacto que compartió, pero todavía no puedo procesarlo. Cuénteme por texto en qué le ayudo.",
  },
  /** No se pudo descargar la foto. */
  photoDownloadFailed: {
    vos: "¡Hola! 🙂 Recibí tu foto pero tuve un problema para verla. ¿Podés volver a mandarla o contarme por texto en qué te ayudo?",
    tu: "¡Hola! 🙂 Recibí tu foto pero tuve un problema para verla. ¿Puedes volver a enviarla o contarme por texto en qué te ayudo?",
    usted: "¡Hola! 🙂 Recibí su foto pero tuve un problema para verla. ¿Puede volver a enviarla o contarme por texto en qué le ayudo?",
  },
  /** No se pudo transcribir la nota de voz. */
  audioFailed: {
    vos: "🎤 Recibí tu nota de voz, pero tuve problemas para escucharla. ¿Podés contarme por texto en qué te ayudo?",
    tu: "🎤 Recibí tu nota de voz, pero tuve problemas para escucharla. ¿Puedes contarme por texto en qué te ayudo?",
    usted: "🎤 Recibí su nota de voz, pero tuve problemas para escucharla. ¿Puede contarme por texto en qué le ayudo?",
  },
  /** Falló el turno del agente (último intento o error permanente). */
  generalError: {
    vos: "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏",
    tu: "Disculpa, tuvimos un problemita. Prueba de nuevo en un momento 🙏",
    usted: "Disculpe, tuvimos un problemita. Pruebe de nuevo en un momento 🙏",
  },
  /** Acuse del botón "Confirmo" del recordatorio. */
  appointmentConfirmedAck: {
    vos: "¡Gracias por confirmar tu cita! ✅ Te esperamos.",
    tu: "¡Gracias por confirmar tu cita! ✅ Te esperamos.",
    usted: "¡Gracias por confirmar su cita! ✅ Le esperamos.",
  },
  /** Acuse del botón "Cancelar" del recordatorio. */
  appointmentCancelledAck: {
    vos: "Listo, tu cita quedó cancelada. Si querés agendar otra, escribinos por acá 🙂",
    tu: "Listo, tu cita quedó cancelada. Si quieres agendar otra, escríbenos por aquí 🙂",
    usted: "Listo, su cita quedó cancelada. Si quiere agendar otra, escríbanos por aquí 🙂",
  },
  /** El botón apunta a una cita que ya no se puede confirmar o cancelar. */
  appointmentReplyUnavailable: {
    vos: "¡Gracias! Esa cita ya no está activa. Si necesitás algo más, escribinos por acá. 🙂",
    tu: "¡Gracias! Esa cita ya no está activa. Si necesitas algo más, escríbenos por aquí. 🙂",
    usted: "¡Gracias! Esa cita ya no está activa. Si necesita algo más, escríbanos por aquí. 🙂",
  },
  /** Freno por cliente (demasiados turnos por hora). No menciona límites ni costos. */
  clientRateLimited: {
    vos: "Recibimos varios mensajes tuyos seguidos 🙏 Una persona del equipo va a revisar la conversación y te responde por acá en cuanto pueda.",
    tu: "Recibimos varios mensajes tuyos seguidos 🙏 Una persona del equipo va a revisar la conversación y te responde por aquí en cuanto pueda.",
    usted: "Recibimos varios mensajes suyos seguidos 🙏 Una persona del equipo va a revisar la conversación y le responde por aquí en cuanto pueda.",
  },
  /** Acuse del pedido de BAJA. */
  optOutAck: {
    vos: "Listo, no vas a recibir más promociones de nuestra parte. Si tenés una cita agendada, igual te van a llegar sus recordatorios. Si necesitás algo más, escribinos por acá 🙂",
    tu: "Listo, no vas a recibir más promociones de nuestra parte. Si tienes una cita agendada, igual te van a llegar sus recordatorios. Si necesitas algo más, escríbenos por aquí 🙂",
    usted:
      "Listo, no va a recibir más promociones de nuestra parte. Si tiene una cita agendada, igual le van a llegar sus recordatorios. Si necesita algo más, escríbanos por aquí 🙂",
  },
  /** Recordatorio de cita en texto con botones (dentro de la ventana de 24 h). Vars: {cliente} {negocio} {cuando} {servicio}. */
  appointmentReminder: {
    vos: "¡Hola {cliente}! 👋 Te recordamos tu cita en {negocio} {cuando}: {servicio}. ¿Nos confirmás?",
    tu: "¡Hola {cliente}! 👋 Te recordamos tu cita en {negocio} {cuando}: {servicio}. ¿Nos confirmas?",
    usted: "¡Hola {cliente}! 👋 Le recordamos su cita en {negocio} {cuando}: {servicio}. ¿Nos confirma?",
  },
  /** Constancia en el historial de una plantilla de reapertura enviada desde la bandeja. */
  reopenTemplateSent: same("📩 Se envió la plantilla para retomar la conversación."),

  // ── Crecimiento (I6) ──
  /** Tras la primera cita agendada, si el negocio tiene Campañas. Vars: {negocio}. */
  marketingConsentQuestion: {
    vos: "Una cosa más 🙂 ¿Querés que {negocio} te avise por acá de promociones y novedades? Podés darte de baja cuando quieras escribiendo BAJA.",
    tu: "Una cosa más 🙂 ¿Quieres que {negocio} te avise por aquí de promociones y novedades? Puedes darte de baja cuando quieras escribiendo BAJA.",
    usted: "Una cosa más 🙂 ¿Desea que {negocio} le avise por aquí de promociones y novedades? Puede darse de baja cuando quiera escribiendo BAJA.",
  },
  marketingConsentYesAck: {
    vos: "¡Listo! 🙌 Te vamos a avisar de promociones por acá. Si en algún momento no querés recibirlas, escribí BAJA.",
    tu: "¡Listo! 🙌 Te vamos a avisar de promociones por aquí. Si en algún momento no quieres recibirlas, escribe BAJA.",
    usted: "¡Listo! 🙌 Le vamos a avisar de promociones por aquí. Si en algún momento no desea recibirlas, escriba BAJA.",
  },
  marketingConsentNoAck: {
    vos: "Entendido 👍 No te vamos a enviar promociones. Tus recordatorios de cita te siguen llegando igual.",
    tu: "Entendido 👍 No te vamos a enviar promociones. Tus recordatorios de cita te siguen llegando igual.",
    usted: "Entendido 👍 No le vamos a enviar promociones. Sus recordatorios de cita le siguen llegando igual.",
  },
  /** Seguimiento post-servicio con botones (dentro de la ventana de 24 h). Vars: {cliente} {servicio} {negocio}. */
  followUpQuestion: {
    vos: "¡Hola {cliente}! 👋 ¿Cómo te fue con {servicio} en {negocio}? Contanos con un toque:",
    tu: "¡Hola {cliente}! 👋 ¿Cómo te fue con {servicio} en {negocio}? Cuéntanos con un toque:",
    usted: "¡Hola {cliente}! 👋 ¿Cómo le fue con {servicio} en {negocio}? Cuéntenos con un toque:",
  },
  /** "Excelente" con link de reseñas. Vars: {link}. */
  followUpPositiveReview: {
    vos: "¡Qué alegría! 🙌 Si tenés un minuto, nos ayudaría muchísimo que dejaras una reseña en Google: {link}",
    tu: "¡Qué alegría! 🙌 Si tienes un minuto, nos ayudaría muchísimo que dejaras una reseña en Google: {link}",
    usted: "¡Qué alegría! 🙌 Si tiene un minuto, nos ayudaría muchísimo que dejara una reseña en Google: {link}",
  },
  followUpPositive: same("¡Qué alegría! 🙌 Gracias por la confianza."),
  followUpNeutral: {
    vos: "¡Gracias por contarnos! 🙂 Si hay algo que podamos mejorar, escribinos por acá.",
    tu: "¡Gracias por contarnos! 🙂 Si hay algo que podamos mejorar, escríbenos por aquí.",
    usted: "¡Gracias por contarnos! 🙂 Si hay algo que podamos mejorar, escríbanos por aquí.",
  },
  followUpNegative: {
    vos: "Lamentamos mucho que no te haya ido bien 😔 Una persona del equipo te va a escribir por acá para resolverlo.",
    tu: "Lamentamos mucho que no te haya ido bien 😔 Una persona del equipo te va a escribir por aquí para resolverlo.",
    usted: "Lamentamos mucho que no le haya ido bien 😔 Una persona del equipo le va a escribir por aquí para resolverlo.",
  },
  /** Rescate de una cotización, primer toque (dentro de la ventana). Vars: {servicio} {monto}. */
  quoteFirstTouch: {
    vos: "¡Hola! 👋 Hace un rato consultaste por {servicio} ({monto}). ¿Querés que te lo agende? Te dejo los próximos horarios libres, o decime qué día te queda bien.",
    tu: "¡Hola! 👋 Hace un rato consultaste por {servicio} ({monto}). ¿Quieres que te lo agende? Te dejo los próximos horarios libres, o dime qué día te queda bien.",
    usted: "¡Hola! 👋 Hace un rato consultó por {servicio} ({monto}). ¿Desea que se lo agende? Le dejo los próximos horarios libres, o dígame qué día le queda bien.",
  },
} satisfies Record<string, ByRegister>;

export type PipelineTextKey = keyof typeof PIPELINE_TEXTS;

/** Claves válidas del override por negocio (`ai_settings.texts`). */
export const PIPELINE_TEXT_KEYS = Object.keys(PIPELINE_TEXTS) as PipelineTextKey[];

/** Títulos de botones (≤ 20 caracteres, neutros: sirven en los tres registros). */
export const BUTTON_TITLES = {
  confirmAppointment: "Confirmo ✅",
  cancelAppointment: "Cancelar",
  marketingYes: "Sí, me interesa",
  marketingNo: "No, gracias",
  followUpPositive: "Excelente 😀",
  followUpNeutral: "Bien 🙂",
  followUpNegative: "Mal 😕",
} as const;

// Países donde se vosea por defecto (el resto, tuteo). El dueño lo cambia en la configuración del agente.
const VOSEO_COUNTRIES = new Set(["CR", "AR", "UY", "PY", "NI", "HN", "SV", "GT"]);

/** Registro: el configurado, o el habitual del país del negocio. */
export function registerFor(configured: string | null | undefined, country: string | null | undefined): AiRegister {
  if (configured === "vos" || configured === "tu" || configured === "usted") return configured;
  return VOSEO_COUNTRIES.has((country ?? "CR").toUpperCase()) ? "vos" : "tu";
}

/** Reemplaza `{variable}`; las desconocidas quedan tal cual. */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
}

/** Lo que define cómo se le habla al cliente de un negocio. */
export interface TextProfile {
  register: AiRegister;
  overrides: Readonly<Record<string, string>>;
  businessName: string;
}

/** Texto para el cliente final: override del negocio o plantilla de su registro, con las variables puestas. */
export function pipelineText(profile: TextProfile, key: PipelineTextKey, vars: Record<string, string | number> = {}): string {
  const raw: unknown = profile.overrides[key];
  const override = typeof raw === "string" ? raw.trim() : "";
  return interpolate(override || PIPELINE_TEXTS[key][profile.register], { negocio: profile.businessName, ...vars });
}
