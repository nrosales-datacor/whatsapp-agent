import type { Registro, Tenant, TextosCliente } from "../types";
import { inferirPaisRegistro } from "./validadores";

// ─────────────────────────────────────────────────────────────────────────────
// Textos del SISTEMA al cliente final (E11, BLOQ-07): todo lo que el bot le manda
// por WhatsApp SIN pasar por el LLM — aviso de bot, escalada, disculpas, acuses de
// botones, recordatorios, rescate, consentimiento, confirmaciones de agenda.
//
// Antes estaban dispersos por handleWebhook/reminders/rescate/campaigns en voseo
// tico fijo (y con un 🚗 en la confirmación y el post-servicio), así que una
// clínica en México recibía "Probá de nuevo" y un carrito. Ahora:
//
//   1. Cada texto tiene una plantilla por REGISTRO (vos / tú / usted). El registro
//      sale de `tenant.registro` o se infiere del país por la zona horaria — la
//      MISMA regla que usa el system prompt (B7), así el LLM y los textos fijos
//      tratan al cliente igual. Un tenant de Costa Rica sin registro configurado
//      sigue recibiendo exactamente el voseo de siempre (el piloto no cambia).
//   2. Override por tenant: `tenant.textosCliente[clave]` (JSONB `textos_cliente`)
//      reemplaza la plantilla entera, con las mismas variables `{negocio}`… Sirve
//      también para un negocio que atiende en otro idioma.
//
// Regla del repo: NINGÚN texto saliente al cliente final vive fuera de este módulo
// (lo vigila test/unit/textosCliente.test.ts con un grep de voseo). Los avisos al
// OPERADOR (push del panel) y las instrucciones al modelo no son de este módulo.
// ─────────────────────────────────────────────────────────────────────────────

/** Plantilla de un texto en los tres registros. Variables con la forma `{nombre}`. */
type PorRegistro = Record<Registro, string>;

/** Igual en los tres registros (textos sin verbos dirigidos al cliente). */
function igual(texto: string): PorRegistro {
  return { vos: texto, tu: texto, usted: texto };
}

/**
 * Catálogo de textos del sistema. Las claves son estables: son también las claves
 * válidas del override por tenant (`textosCliente`), así que renombrar una rompe
 * los overrides guardados — agregar es libre, renombrar no.
 */
export const PLANTILLAS = {
  /** Aviso de transparencia del primer contacto (opt-in). Vars: {negocio}. */
  avisoBot: {
    vos: "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.",
    tu: "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribe *agente* si prefieres hablar con una persona.",
    usted:
      "👋 ¡Hola! Soy el asistente automatizado de {negocio}. Puedo darle información de servicios, precios y horarios, y agendarle una cita. Escriba *agente* si prefiere hablar con una persona.",
  },
  /** El bot no pudo resolver y pasa el caso a una persona. */
  escalada: {
    vos: "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.",
    tu: "Déjame consultarlo con una persona del equipo 🙋 En un momento te responden por aquí.",
    usted: "Permítame consultarlo con una persona del equipo 🙋 En un momento le responden por aquí.",
  },
  /** El cliente pidió explícitamente hablar con una persona ("agente"). */
  traspasoHumano: {
    vos: "¡Listo! Te paso con una persona del equipo. En un momento te responden por acá. 🙋",
    tu: "¡Listo! Te paso con una persona del equipo. En un momento te responden por aquí. 🙋",
    usted: "¡Listo! Le paso con una persona del equipo. En un momento le responden por aquí. 🙋",
  },
  /** Tope mensual de conversaciones alcanzado (F10). `tenant.mensajeTopeExcedido` sigue mandando sobre esto. */
  topeExcedido: {
    vos: "¡Gracias por escribirnos! 🙌 En un momento te atiende alguien del equipo.",
    tu: "¡Gracias por escribirnos! 🙌 En un momento te atiende alguien del equipo.",
    usted: "¡Gracias por escribirnos! 🙌 En un momento le atiende alguien del equipo.",
  },
  /** Tope mensual de gasto de IA: neutro a propósito (no debe leerse como "se acabó el servicio"). */
  topeGasto: {
    vos: "¡Gracias por escribirnos! 🙂 En un momento te atiende una persona del equipo por acá.",
    tu: "¡Gracias por escribirnos! 🙂 En un momento te atiende una persona del equipo por aquí.",
    usted: "¡Gracias por escribirnos! 🙂 En un momento le atiende una persona del equipo por aquí.",
  },
  /** Sticker o video (lo que el bot no puede leer). */
  multimediaNoSoportada: {
    vos: "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Contame por texto (o mandame una foto) en qué te puedo ayudar y con gusto te atiendo.",
    tu: "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Cuéntame por texto (o envíame una foto) en qué te puedo ayudar y con gusto te atiendo.",
    usted:
      "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Cuénteme por texto (o envíeme una foto) en qué le puedo ayudar y con gusto le atiendo.",
  },
  documentoNoSoportado: {
    vos: "¡Hola! 🙂 Recibí tu documento, pero todavía no puedo abrirlo. Contame por texto en qué te ayudo y si hace falta alguien del equipo lo revisa.",
    tu: "¡Hola! 🙂 Recibí tu documento, pero todavía no puedo abrirlo. Cuéntame por texto en qué te ayudo y si hace falta alguien del equipo lo revisa.",
    usted:
      "¡Hola! 🙂 Recibí su documento, pero todavía no puedo abrirlo. Cuénteme por texto en qué le ayudo y si hace falta alguien del equipo lo revisa.",
  },
  contactoNoSoportado: {
    vos: "¡Hola! 🙂 Recibí el contacto que compartiste, pero todavía no puedo procesarlo. Contame por texto en qué te ayudo.",
    tu: "¡Hola! 🙂 Recibí el contacto que compartiste, pero todavía no puedo procesarlo. Cuéntame por texto en qué te ayudo.",
    usted: "¡Hola! 🙂 Recibí el contacto que compartió, pero todavía no puedo procesarlo. Cuénteme por texto en qué le ayudo.",
  },
  /** No se pudo descargar la foto del cliente. */
  fotoNoDescargada: {
    vos: "¡Hola! 🙂 Recibí tu foto pero tuve un problema para verla. ¿Podés volver a mandarla o contarme por texto en qué te ayudo?",
    tu: "¡Hola! 🙂 Recibí tu foto pero tuve un problema para verla. ¿Puedes volver a enviarla o contarme por texto en qué te ayudo?",
    usted: "¡Hola! 🙂 Recibí su foto pero tuve un problema para verla. ¿Puede volver a enviarla o contarme por texto en qué le ayudo?",
  },
  /** Falló el turno del agente con una foto (último intento). */
  errorFoto: {
    vos: "Disculpá, tuvimos un problemita viendo tu foto. Probá de nuevo en un momento 🙏",
    tu: "Disculpa, tuvimos un problemita viendo tu foto. Prueba de nuevo en un momento 🙏",
    usted: "Disculpe, tuvimos un problemita viendo su foto. Pruebe de nuevo en un momento 🙏",
  },
  /** Falló el turno del agente (último intento o error permanente). */
  errorGeneral: {
    vos: "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏",
    tu: "Disculpa, tuvimos un problemita. Prueba de nuevo en un momento 🙏",
    usted: "Disculpe, tuvimos un problemita. Pruebe de nuevo en un momento 🙏",
  },
  /** Whisper no pudo transcribir la nota de voz. */
  audioFallido: {
    vos: "🎤 Recibí tu nota de voz, pero tuve problemas para escucharla. ¿Podés contarme por texto en qué te ayudo?",
    tu: "🎤 Recibí tu nota de voz, pero tuve problemas para escucharla. ¿Puedes contarme por texto en qué te ayudo?",
    usted: "🎤 Recibí su nota de voz, pero tuve problemas para escucharla. ¿Puede contarme por texto en qué le ayudo?",
  },
  /** El modelo devolvió un mensaje vacío. */
  noEntendi: {
    vos: "Disculpá, no entendí. ¿Me lo repetís?",
    tu: "Disculpa, no entendí. ¿Me lo repites?",
    usted: "Disculpe, no entendí. ¿Me lo repite?",
  },
  /**
   * Ejemplo de respuesta "fuera de alcance" que el system prompt le da al modelo.
   * Vars: {negocio}. Mantener "solo puedo ayudar…": `esRespuestaFueraDeAlcance` lo detecta.
   */
  fueraDeAlcance: {
    vos: "Disculpá, solo puedo ayudarte con cosas de {negocio} 🙂 ¿En qué te puedo ayudar?",
    tu: "Disculpa, solo puedo ayudarte con cosas de {negocio} 🙂 ¿En qué te puedo ayudar?",
    usted: "Disculpe, solo puedo ayudarle con cosas de {negocio} 🙂 ¿En qué le puedo ayudar?",
  },
  /** Acuse del botón "Confirmo" del recordatorio. */
  citaConfirmadaAck: {
    vos: "¡Gracias por confirmar tu cita! ✅ Te esperamos.",
    tu: "¡Gracias por confirmar tu cita! ✅ Te esperamos.",
    usted: "¡Gracias por confirmar su cita! ✅ Le esperamos.",
  },
  /** Acuse genérico (p. ej. confirmar una cita que ya no existe). */
  graciasGenerico: {
    vos: "¡Gracias! Si necesitás algo más, escribinos por acá. 🙂",
    tu: "¡Gracias! Si necesitas algo más, escríbenos por aquí. 🙂",
    usted: "¡Gracias! Si necesita algo más, escríbanos por aquí. 🙂",
  },
  /** Post-servicio "todo bien" con link de reseñas. Vars: {link}. */
  postServicioPositivoResena: {
    vos: "¡Qué alegría! 🙌 Si tenés un minuto, nos ayudaría muchísimo que dejaras una reseña en Google: {link}",
    tu: "¡Qué alegría! 🙌 Si tienes un minuto, nos ayudaría muchísimo que dejaras una reseña en Google: {link}",
    usted: "¡Qué alegría! 🙌 Si tiene un minuto, nos ayudaría muchísimo que dejara una reseña en Google: {link}",
  },
  postServicioPositivo: igual("¡Qué alegría! 🙌 Gracias por la confianza."),
  postServicioNeutral: igual("¡Qué bueno! 🙌 Gracias por la confianza."),
  postServicioNegativo: {
    vos: "Lamentamos escuchar eso 🙏 Ya le avisamos a una persona del equipo para que te contacte.",
    tu: "Lamentamos escuchar eso 🙏 Ya le avisamos a una persona del equipo para que te contacte.",
    usted: "Lamentamos escuchar eso 🙏 Ya le avisamos a una persona del equipo para que se comunique con usted.",
  },
  /** Recordatorio de cita en texto libre (sin plantilla de Meta). Vars: {cliente} {negocio} {cuando} {servicio}. */
  recordatorioCita: {
    vos: "¡Hola {cliente}! 👋 Te recordamos tu cita en {negocio} {cuando}: {servicio}. ¿Nos confirmás?",
    tu: "¡Hola {cliente}! 👋 Te recordamos tu cita en {negocio} {cuando}: {servicio}. ¿Nos confirmas?",
    usted: "¡Hola {cliente}! 👋 Le recordamos su cita en {negocio} {cuando}: {servicio}. ¿Nos confirma?",
  },
  /** Pregunta del seguimiento post-servicio. Vars: {cliente} {servicio} {negocio}. */
  postServicioPregunta: {
    vos: "¡Hola {cliente}! 👋 ¿Cómo te fue con tu {servicio} en {negocio}?",
    tu: "¡Hola {cliente}! 👋 ¿Cómo te fue con tu {servicio} en {negocio}?",
    usted: "¡Hola {cliente}! 👋 ¿Cómo le fue con su {servicio} en {negocio}?",
  },
  /** Primer toque del rescate de cotizaciones (default; `tenant.rescateToque1Texto` manda). Vars: {servicio} {monto} {n}. */
  rescateToque1: {
    vos: "¡Hola! 👋 ¿Te guardo el espacio para el {servicio} ({monto})? Me quedan {n} horarios libres.",
    tu: "¡Hola! 👋 ¿Te guardo el espacio para el {servicio} ({monto})? Me quedan {n} horarios libres.",
    usted: "¡Hola! 👋 ¿Le guardo el espacio para el {servicio} ({monto})? Me quedan {n} horarios libres.",
  },
  /** Freno por cliente (demasiados turnos por hora). Neutro: no menciona límites ni costos. */
  limiteCliente: {
    vos: "Recibimos varios mensajes tuyos seguidos 🙏 Una persona del equipo va a revisar la conversación y te responde por acá en cuanto pueda.",
    tu: "Recibimos varios mensajes tuyos seguidos 🙏 Una persona del equipo va a revisar la conversación y te responde por aquí en cuanto pueda.",
    usted:
      "Recibimos varios mensajes suyos seguidos 🙏 Una persona del equipo va a revisar la conversación y le responde por aquí en cuanto pueda.",
  },
  /** Pedido de consentimiento de marketing. Vars: {negocio}. Debe decir quién, qué y cómo darse de baja. */
  consentimientoPedido: {
    vos: "¿Te gustaría que {negocio} te avise por WhatsApp de promociones y novedades de vez en cuando? Es opcional y podés darte de baja cuando quieras escribiendo BAJA.",
    tu: "¿Te gustaría que {negocio} te avise por WhatsApp de promociones y novedades de vez en cuando? Es opcional y puedes darte de baja cuando quieras escribiendo BAJA.",
    usted:
      "¿Le gustaría que {negocio} le avise por WhatsApp de promociones y novedades de vez en cuando? Es opcional y puede darse de baja cuando quiera escribiendo BAJA.",
  },
  consentimientoSi: {
    vos: "¡Listo! 🙌 Te vamos a avisar de promociones de vez en cuando. Si en algún momento no querés recibir más, escribí BAJA.",
    tu: "¡Listo! 🙌 Te vamos a avisar de promociones de vez en cuando. Si en algún momento no quieres recibir más, escribe BAJA.",
    usted: "¡Listo! 🙌 Le vamos a avisar de promociones de vez en cuando. Si en algún momento no quiere recibir más, escriba BAJA.",
  },
  consentimientoNo: {
    vos: "Entendido, no te vamos a enviar promociones. ¡Gracias! 🙂",
    tu: "Entendido, no te vamos a enviar promociones. ¡Gracias! 🙂",
    usted: "Entendido, no le vamos a enviar promociones. ¡Gracias! 🙂",
  },
  /** Acuse del pedido de baja de campañas. */
  bajaAck: {
    vos: "Listo, no vas a recibir más promociones de nuestra parte. Si tenés una cita agendada, igual te van a llegar sus recordatorios. Si necesitás algo más, escribinos por acá 🙂",
    tu: "Listo, no vas a recibir más promociones de nuestra parte. Si tienes una cita agendada, igual te van a llegar sus recordatorios. Si necesitas algo más, escríbenos por aquí 🙂",
    usted:
      "Listo, no va a recibir más promociones de nuestra parte. Si tiene una cita agendada, igual le van a llegar sus recordatorios. Si necesita algo más, escríbanos por aquí 🙂",
  },
  /** Confirmaciones FIJAS de agenda (red de seguridad G5). Vars: {servicio} {fecha} {hora}. */
  citaAgendada: {
    vos: "✅ Tu cita quedó agendada: {servicio}, {fecha} a las {hora}.",
    tu: "✅ Tu cita quedó agendada: {servicio}, {fecha} a las {hora}.",
    usted: "✅ Su cita quedó agendada: {servicio}, {fecha} a las {hora}.",
  },
  citaReprogramada: {
    vos: "✅ Tu cita quedó cambiada: {servicio}, {fecha} a las {hora}.",
    tu: "✅ Tu cita quedó cambiada: {servicio}, {fecha} a las {hora}.",
    usted: "✅ Su cita quedó cambiada: {servicio}, {fecha} a las {hora}.",
  },
  /** Vars: {servicio} {fecha}. */
  citaCancelada: {
    vos: "Tu cita de {servicio} del {fecha} quedó cancelada.",
    tu: "Tu cita de {servicio} del {fecha} quedó cancelada.",
    usted: "Su cita de {servicio} del {fecha} quedó cancelada.",
  },
} satisfies Record<string, PorRegistro>;

export type ClaveTexto = keyof typeof PLANTILLAS;

/** Claves válidas del override por tenant (= las del catálogo). */
export const CLAVES_TEXTO = Object.keys(PLANTILLAS) as ClaveTexto[];

/**
 * Registro con el que se le habla al cliente: el configurado, o el inferido del país
 * por la zona horaria. MISMA regla que `construirSystemPrompt` (B7).
 */
export function registroDe(tenant: Pick<Tenant, "registro" | "timezone">): Registro {
  return tenant.registro ?? inferirPaisRegistro(tenant.timezone).registro;
}

/** Reemplaza `{variable}` por su valor; las variables desconocidas quedan tal cual. */
export function interpolar(plantilla: string, vars: Record<string, string | number> = {}): string {
  return plantilla.replace(/\{(\w+)\}/g, (todo, nombre: string) =>
    Object.prototype.hasOwnProperty.call(vars, nombre) ? String(vars[nombre]) : todo,
  );
}

/**
 * Texto del sistema para el cliente final de ESTE negocio: override del tenant si lo
 * tiene, si no la plantilla de su registro; con las variables ya reemplazadas.
 */
export function textoCliente(
  tenant: Pick<Tenant, "registro" | "timezone" | "textosCliente">,
  clave: ClaveTexto,
  vars: Record<string, string | number> = {},
): string {
  // `typeof` y no solo `?.trim()`: el JSONB viene de la base y un valor que no sea
  // texto (escrito a mano, versión vieja) no debe tumbar el envío — cae al catálogo.
  const crudo: unknown = tenant.textosCliente?.[clave];
  const override = typeof crudo === "string" ? crudo.trim() : "";
  const plantilla = override || PLANTILLAS[clave][registroDe(tenant)];
  return interpolar(plantilla, vars);
}

/**
 * ¿La respuesta del modelo es la deflección de "fuera de alcance"? Antes se detectaba
 * con la frase en voseo ("solo puedo ayudarte con"); el modelo ahora responde en el
 * idioma del cliente y con el registro del negocio, así que se aceptan las variantes
 * (ayudarte/ayudarle/ayudarlo, y en inglés/portugués). Solo alimenta la métrica de
 * calidad (`fuera_de_alcance`): un falso negativo no cambia lo que recibe el cliente.
 */
export function esRespuestaFueraDeAlcance(respuesta: string): boolean {
  return (
    /solo\s+(?:te\s+|le\s+|lo\s+|la\s+)?puedo\s+ayudar(?:te|le|lo|la)?\s+(?:con|en)\b/i.test(respuesta) ||
    /\bI\s+can\s+only\s+help\b/i.test(respuesta) ||
    /s[óo]\s+posso\s+ajudar/i.test(respuesta)
  );
}

/**
 * Turno sintético para el agente cuando el cliente manda una foto sin texto. Va al
 * MODELO (no al cliente) y en infinitivo/tercera persona a propósito: sin voseo que el
 * modelo copie, así responde con el registro del prompt y en el idioma del cliente.
 */
export const TURNO_FOTO_SIN_COMENTARIO =
  "[El cliente envió una foto sin comentario. Analizarla y ayudarle según la información del negocio.]";

// ── Botones y listas (títulos ≤20 chars, límite de Meta) ─────────────────────
// Neutros a propósito (sin verbos conjugados al cliente): sirven igual para los tres
// registros. Viven acá para que todo lo que ve el cliente esté en un solo lugar.
export const BOTONES = {
  confirmarCita: "Confirmo ✅",
  reprogramarCita: "Reprogramar",
  postTodoBien: "Todo bien 👍",
  postProblema: "Tuve un problema",
  postExcelente: "Excelente 😃",
  postBien: "Bien 🙂",
  postMal: "Mal 😞",
  consentimientoSi: "Sí, avísenme",
  consentimientoNo: "No, gracias",
  verHorarios: "Ver horarios",
  verOpciones: "Ver opciones",
} as const;

// ── Override por tenant ───────────────────────────────────────────────────────

/** Largo máximo de cada texto override (WhatsApp corta en 4096; los botones usan otro límite). */
export const MAX_TEXTO_CLIENTE = 1000;

/**
 * Valida el override de textos de un tenant (JSONB `textos_cliente`). Descarta las
 * entradas vacías; rechaza (null) claves desconocidas, valores no-texto o demasiado
 * largos — mismo criterio "error explícito antes que guardar basura" que el resto de
 * validadores.ts. `{}`/null/undefined = sin overrides.
 */
export function validarTextosCliente(v: unknown): TextosCliente | null {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: TextosCliente = {};
  for (const [clave, valor] of Object.entries(v as Record<string, unknown>)) {
    if (!(CLAVES_TEXTO as string[]).includes(clave)) return null;
    if (valor === null || valor === undefined) continue;
    if (typeof valor !== "string") return null;
    const s = valor.trim();
    if (!s) continue;
    if (s.length > MAX_TEXTO_CLIENTE) return null;
    out[clave as ClaveTexto] = s;
  }
  return out;
}
