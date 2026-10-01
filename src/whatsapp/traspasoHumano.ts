import type { Conversacion, MensajeConversacion } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Traspaso a humano: cuándo se activa y cuándo vence (revisión pre-venta 2026-10).
//
// ANTES: el regex `/\bagente\b|\bhumano\b|\bpersona\b/` buscaba la palabra en
// CUALQUIER parte del texto, así que "¿cuánto cuesta por persona?" o "es para otra
// persona" pasaban la conversación a modo humano. Y nada la devolvía al bot (solo
// un clic manual en el panel): si nadie del equipo contestaba, el cliente quedaba
// sin respuesta para siempre.
//
// AHORA:
//   • `pideHumano` solo dispara con un pedido EXPLÍCITO ("agente", "quiero hablar
//     con una persona", "pasame con un asesor", "talk to a human"). Los pedidos
//     más sutiles los cubre el propio agente con la herramienta `escalar_a_humano`.
//   • `modoHumanoVencido`: si nadie del equipo actuó (ni traspaso nuevo ni mensaje
//     desde el panel) en `MODO_HUMANO_VENCE_HORAS` (default 12; 0 = nunca vence),
//     la conversación vuelve al bot cuando el cliente escribe de nuevo.
// ─────────────────────────────────────────────────────────────────────────────

/** minúsculas, sin tildes, solo letras/dígitos separados por un espacio. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

const SUSTANTIVO = "(?:agente|humano|humana|persona|asesor|asesora|operador|operadora|encargado|encargada|alguien)";

// Mensaje que es SOLO el pedido: "agente", "una persona", "humano por favor", "hola, agente".
const SOLO_PEDIDO = new RegExp(
  `^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches)\\s+)?(?:un |una |el |la )?` +
    `(?:agente|humano|humana|persona|asesor|asesora|operador|operadora|agent|human)(?: real)?` +
    `(?:\\s+(?:por favor|porfa|porfis|please|pls))?$`,
);

// Verbo de contacto + (palabras intermedias) + preposición/artículo + sustantivo:
// "quiero hablar con una persona", "pasame con un asesor", "que me atienda una persona".
// Exige el conector (con/a/un/una/algun) justo antes del sustantivo: así "pasame el
// precio POR persona" o "atienda a OTRA persona" no disparan.
const VERBO_CONTACTO = new RegExp(
  `\\b(?:hablar|hablo|habla|comunicar|comunicarme|comunicarse|comunicame|comuniqueme|comunican|` +
    `comunicas|comunica|pasar|pasarme|pasame|paseme|pasas|pase|pasan|pasen|pasenme|contactar|contactarme|` +
    `atienda|atiendan|atenderme)\\b` +
    `(?:\\s+\\S+){0,3}?\\s+(?:con|a|un|una|algun|alguna)(?:\\s+(?:un|una|el|la|algun|alguna))?\\s+${SUSTANTIVO}\\b`,
);

// "quiero un agente", "necesito una persona", "prefiero un humano".
const QUIERO_UN = new RegExp(
  `\\b(?:quiero|necesito|prefiero|pido)\\s+(?:a\\s+)?(?:un|una)\\s+` +
    `(?:agente|humano|humana|persona|asesor|asesora|operador|operadora)\\b`,
);

const INGLES = /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a|an|the|some)?\s*(?:human|agent|person|someone|representative)\b/;

/** true si el cliente pidió de forma explícita hablar con una persona. */
export function pideHumano(texto: string): boolean {
  const t = normalizar(texto);
  if (!t) return false;
  return SOLO_PEDIDO.test(t) || VERBO_CONTACTO.test(t) || QUIERO_UN.test(t) || INGLES.test(t);
}

function horasVencimiento(): number {
  const n = Number(process.env.MODO_HUMANO_VENCE_HORAS ?? 12);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

/**
 * true si la conversación está en modo humano pero el equipo no actuó en las
 * últimas N horas: ni un traspaso nuevo (`conv.humanoDesde`) ni un mensaje desde
 * el panel (`porHumano`). Los mensajes del CLIENTE no cuentan (si insiste "¿hay
 * alguien?" cada hora, igual debe vencer). Sin ninguna referencia de tiempo, no
 * vence (conservador: no le quita la conversación a un operador por falta de datos).
 */
export function modoHumanoVencido(
  conv: Pick<Conversacion, "modo" | "humanoDesde">,
  historial: MensajeConversacion[],
  ahora: Date = new Date(),
  horas: number = horasVencimiento(),
): boolean {
  if (conv.modo !== "humano" || horas === 0) return false;
  const marcas = [conv.humanoDesde, ...historial.filter((m) => m.porHumano).map((m) => m.creadoEn)]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms));
  if (marcas.length === 0) return false;
  return ahora.getTime() - Math.max(...marcas) >= horas * 3_600_000;
}
