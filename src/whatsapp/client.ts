import crypto from "node:crypto";
import type { MensajeInteractivo, OpcionInteractiva, Tenant } from "../types";
import { registrarMensajeSaliente } from "../observabilidad/uso";

// ⚠️ La versión del Graph API cambia con el tiempo. Confirmá la vigente en la
// documentación de Meta antes de producción. Se deja configurable por .env.
const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? "v21.0";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Verificación del webhook (GET). Meta manda hub.challenge al configurarlo.
// ─────────────────────────────────────────────────────────────────────────────
export function verificarWebhook(params: URLSearchParams): { ok: boolean; challenge?: string } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return { ok: true, challenge: challenge ?? "" };
  }
  return { ok: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Validación de firma (X-Hub-Signature-256). Asegura que el POST viene de Meta.
//    Requiere el cuerpo CRUDO (string), no el JSON ya parseado.
// ─────────────────────────────────────────────────────────────────────────────
export function firmaValida(rawBody: string, firmaHeader: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !firmaHeader) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Comparación de tiempo constante.
  const a = Buffer.from(esperado);
  const b = Buffer.from(firmaHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Parseo del mensaje entrante. Devuelve solo lo que nos interesa.
// ─────────────────────────────────────────────────────────────────────────────
export interface MensajeEntrante {
  phoneNumberId: string; // a qué número llegó → identifica el tenant
  clienteWa: string; // número del cliente, SOLO dígitos (E.164 sin "+")
  texto: string; // texto del mensaje (vacío si no es texto)
  esTexto: boolean;
  /** id del mensaje en WhatsApp (msg.id). Para deduplicar reintentos de Meta. */
  messageId?: string;
  /** id del media de audio (cuando msg.type === "audio"). Para transcribir en fase 2. */
  audioId?: string;
  /** id del media de imagen (cuando msg.type === "image"). Para cotizar con visión en fase 2. */
  imagenId?: string;
  /** leyenda opcional que el cliente escribió junto a la foto. */
  imagenCaption?: string;
  /**
   * id CRUDO de la respuesta interactiva (el `id` que pusimos en el botón/fila),
   * cuando el cliente tocó un botón o una fila de lista. Permite acciones directas
   * (p. ej. confirmar una cita) sin pasar por el agente. `texto` trae su traducción.
   */
  interactiveId?: string;
}

export function parsearEntrante(body: any): MensajeEntrante | null {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return null; // puede ser un status (entregado/leído), lo ignoramos
    const phoneNumberId = value?.metadata?.phone_number_id;
    // Saneamos el "from" a solo dígitos: nunca confiamos en el payload crudo. Así un
    // número con caracteres raros no se cuela a la UI del panel (defensa en
    // profundidad contra XSS) y la clave del cliente queda consistente.
    const clienteWa = String(msg.from ?? "").replace(/\D/g, "");
    let esTexto = msg.type === "text";
    let texto = esTexto ? (msg.text?.body ?? "") : "";
    const audioId = msg.type === "audio" ? (msg.audio?.id ? String(msg.audio.id) : undefined) : undefined;
    const imagenId = msg.type === "image" ? (msg.image?.id ? String(msg.image.id) : undefined) : undefined;
    const imagenCaption = msg.type === "image" && msg.image?.caption ? String(msg.image.caption) : undefined;

    // Respuesta a un mensaje interactivo (el cliente tocó un botón o una fila de
    // lista). La tratamos como TEXTO: la decodificamos a una frase clara para que
    // fluya por el mismo pipeline del agente (dedup, cola, historial) sin ramas
    // nuevas. La convención del `id` la definimos nosotros al enviar (ver abajo).
    let interactiveId: string | undefined;
    if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      interactiveId = reply?.id ? String(reply.id) : undefined;
      const titulo = reply?.title ? String(reply.title) : "";
      texto = decodificarRespuestaInteractiva(interactiveId ?? "", titulo);
      esTexto = !!texto; // si no se pudo decodificar, cae al flujo no-texto
    }

    if (!phoneNumberId || !clienteWa) return null;
    return {
      phoneNumberId,
      clienteWa,
      texto,
      esTexto,
      messageId: msg.id ? String(msg.id) : undefined,
      audioId,
      imagenId,
      imagenCaption,
      interactiveId,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocolo de mensajes interactivos (C1.2).
//
// El `id` de cada botón/fila es opaco para WhatsApp pero lo definimos nosotros con
// una convención "tipo|arg|arg…". Al enviar lo generamos (opcionHorario, etc.) y al
// llegar la respuesta lo decodificamos a una frase clara para el agente. Mantener el
// codificador y el decodificador juntos evita que se desincronicen.
// ─────────────────────────────────────────────────────────────────────────────

/** "14:00" → "2:00 p.m." (título amigable para las filas de la lista). */
function horaAmigable(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const sufijo = h < 12 ? "a.m." : "p.m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${sufijo}`;
}

/** Construye una opción de lista para un horario de cita. */
export function opcionHorario(fecha: string, hora: string): OpcionInteractiva {
  return { id: `slot|${fecha}|${hora}`, titulo: horaAmigable(hora) };
}

/** Botones del recordatorio de cita (C1.3): confirmar o pedir reprogramación. */
export function botonesRecordatorio(citaId: string): OpcionInteractiva[] {
  return [
    { id: `confirmar|${citaId}`, titulo: "Confirmo ✅" },
    { id: `mover|${citaId}`, titulo: "Reprogramar" },
  ];
}

/** true si la respuesta interactiva es una CONFIRMACIÓN de cita (acción directa). */
export function esConfirmacionCita(interactiveId: string | undefined): string | null {
  if (!interactiveId) return null;
  const [tipo, citaId] = interactiveId.split("|");
  return tipo === "confirmar" && citaId ? citaId : null;
}

/** Botones del seguimiento post-servicio (C3.1): satisfacción del cliente. */
export function botonesPostServicio(citaId: string): OpcionInteractiva[] {
  return [
    { id: `postbien|${citaId}`, titulo: "Todo bien 👍" },
    { id: `postmal|${citaId}`, titulo: "Tuve un problema" },
  ];
}

/**
 * Si la respuesta interactiva es del seguimiento post-servicio (C3.1), devuelve la
 * cita y si el cliente marcó que todo salió bien. Acción directa (no pasa por el
 * agente): "bien" pide la reseña, "mal" escala a un humano ANTES de que se
 * convierta en reseña negativa.
 */
export function respuestaPostServicio(interactiveId: string | undefined): { citaId: string; bien: boolean } | null {
  if (!interactiveId) return null;
  const [tipo, citaId] = interactiveId.split("|");
  if (!citaId) return null;
  if (tipo === "postbien") return { citaId, bien: true };
  if (tipo === "postmal") return { citaId, bien: false };
  return null;
}

/**
 * Traduce el `id` de una respuesta interactiva a la frase que "diría" el cliente,
 * para inyectarla al agente como si la hubiera escrito. Si el id no matchea ninguna
 * convención conocida, cae al título visible del botón/fila.
 */
function decodificarRespuestaInteractiva(id: string, titulo: string): string {
  const [tipo, ...resto] = id.split("|");
  if (tipo === "slot" && resto.length === 2) {
    const [fecha, hora] = resto;
    return `Quiero agendar para el ${fecha} a las ${hora}.`;
  }
  // Confirmación de cita: se maneja como acción directa en handleWebhook (no llega
  // al agente), pero igual dejamos un texto legible para el historial del panel.
  if (tipo === "confirmar") return "Confirmo mi cita ✅";
  // Pedido de reprogramar desde el recordatorio: fluye al agente, que arranca el
  // flujo de reprogramación (C1.1) identificando la cita por el número del cliente.
  if (tipo === "mover") return "Quiero reprogramar mi cita.";
  // Seguimiento post-servicio (C3.1): también son acción directa en handleWebhook,
  // pero dejamos un texto legible para el historial del panel.
  if (tipo === "postbien") return "Todo bien con el servicio 👍";
  if (tipo === "postmal") return "Tuve un problema con el servicio 😕";
  return titulo;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Envío de mensajes a la Graph API, con REINTENTOS ante fallos transitorios.
//
// Meta a veces devuelve hipos momentáneos y recuperables (los marca con
// `is_transient: true`, p. ej. «(#2) Service temporarily unavailable»), además de
// rate limits (429) y errores de servidor (5xx). Sin reintento, un solo hipo deja
// al cliente sin respuesta — fue justo lo que pasó: una respuesta del bot se
// perdió por un error transitorio y el cliente esperó horas. Reintentamos con
// backoff exponencial. Esto corre en la fase 2 (después del 200 a Meta), así que
// unos segundos extra no bloquean el webhook.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_INTENTOS_ENVIO = 3;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Backoff antes de reintentar tras el intento `n` que falló: 500ms, 1500ms… (tope 5s).
const retardoMs = (intentoFallido: number) => Math.min(500 * 3 ** (intentoFallido - 1), 5000);

function statusEsTransitorio(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Códigos de error de Meta tratados como transitorios aunque lleguen con HTTP 400/200.
// Ref Meta: 1 (API desconocido), 2 (servicio no disponible), 4/80007/130429 (rate
// limit), 131000 («algo salió mal»), 131016 (servicio no disponible), 133016.
const CODIGOS_META_TRANSITORIOS = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 133016]);

function cuerpoEsTransitorio(detalle: string): boolean {
  try {
    const err = JSON.parse(detalle)?.error;
    if (!err) return false;
    if (err.is_transient === true) return true;
    return typeof err.code === "number" && CODIGOS_META_TRANSITORIOS.has(err.code);
  } catch {
    return false; // no es JSON de Meta → no asumimos transitorio
  }
}

// POST genérico a /{phone_number_id}/messages con reintentos. `etiqueta` arma el
// mensaje de error (se conserva el formato «Error enviando WhatsApp (status): …»).
async function postMensaje(
  tenant: Tenant,
  contenido: Record<string, unknown>,
  etiqueta: string,
  plantillaCategoria?: "marketing" | "utilidad",
): Promise<void> {
  const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("Falta access token de WhatsApp para el tenant " + tenant.id);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${tenant.phoneNumberId}/messages`;
  const cuerpo = JSON.stringify({ messaging_product: "whatsapp", ...contenido });

  let ultimoError: Error | null = null;
  for (let intento = 1; intento <= MAX_INTENTOS_ENVIO; intento++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: cuerpo,
      });
    } catch (e) {
      // fetch lanzó (DNS/red/timeout): siempre transitorio.
      ultimoError = e instanceof Error ? e : new Error(String(e));
      if (intento < MAX_INTENTOS_ENVIO) {
        console.warn(`[whatsapp] red falló (intento ${intento}/${MAX_INTENTOS_ENVIO}), reintento: ${ultimoError.message}`);
        await dormir(retardoMs(intento));
        continue;
      }
      throw ultimoError;
    }

    if (res.ok) {
      // Contador de uso mensual (Carril D, 0.2): solo se cuenta un envío exitoso.
      registrarMensajeSaliente(tenant.id, plantillaCategoria);
      return;
    }

    const detalle = await res.text();
    ultimoError = new Error(`Error ${etiqueta} (${res.status}): ${detalle}`);
    const transitorio = statusEsTransitorio(res.status) || cuerpoEsTransitorio(detalle);
    if (transitorio && intento < MAX_INTENTOS_ENVIO) {
      console.warn(`[whatsapp] envío transitorio falló (intento ${intento}/${MAX_INTENTOS_ENVIO}), reintento: ${detalle.slice(0, 140)}`);
      await dormir(retardoMs(intento));
      continue;
    }
    throw ultimoError; // error permanente, o se agotaron los intentos
  }
  throw ultimoError ?? new Error(`Error ${etiqueta}: se agotaron los reintentos`);
}

// Envío de un mensaje de texto al cliente.
export async function enviarTexto(tenant: Tenant, paraWa: string, texto: string): Promise<void> {
  await postMensaje(
    tenant,
    { to: paraWa, type: "text", text: { body: texto.slice(0, 4096) } }, // 4096 = límite de WhatsApp
    "enviando WhatsApp",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b) Envío de MENSAJES INTERACTIVOS (botones y listas nativas de WhatsApp).
//     Solo Graph API, sin dependencias nuevas. La respuesta del cliente llega como
//     un mensaje `type: "interactive"` que parsearEntrante decodifica.
//
//     Límites de Meta (se recortan defensivamente para no fallar el envío):
//       • Botones: hasta 3; título ≤20 chars.
//       • Lista: hasta 10 filas en total; título de fila ≤24, descripción ≤72;
//         texto del botón que abre la lista ≤20.
//       • Cuerpo ≤1024 chars.
// ─────────────────────────────────────────────────────────────────────────────
const LIMITE_BOTONES = 3;
const LIMITE_FILAS_LISTA = 10;

export async function enviarBotones(
  tenant: Tenant,
  paraWa: string,
  cuerpo: string,
  botones: OpcionInteractiva[],
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: cuerpo.slice(0, 1024) },
        action: {
          buttons: botones.slice(0, LIMITE_BOTONES).map((b) => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: b.titulo.slice(0, 20) },
          })),
        },
      },
    },
    "enviando botones WhatsApp",
  );
}

export async function enviarLista(
  tenant: Tenant,
  paraWa: string,
  cuerpo: string,
  textoBoton: string,
  filas: OpcionInteractiva[],
  tituloSeccion = "Opciones",
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: cuerpo.slice(0, 1024) },
        action: {
          button: textoBoton.slice(0, 20),
          sections: [
            {
              title: tituloSeccion.slice(0, 24),
              rows: filas.slice(0, LIMITE_FILAS_LISTA).map((f) => ({
                id: f.id.slice(0, 200),
                title: f.titulo.slice(0, 24),
                ...(f.descripcion ? { description: f.descripcion.slice(0, 72) } : {}),
              })),
            },
          ],
        },
      },
    },
    "enviando lista WhatsApp",
  );
}

/** Despacha un MensajeInteractivo al canal correcto (botones o lista). */
export async function enviarInteractivo(
  tenant: Tenant,
  paraWa: string,
  msg: MensajeInteractivo,
): Promise<void> {
  if (msg.tipo === "botones") {
    await enviarBotones(tenant, paraWa, msg.cuerpo, msg.opciones);
  } else {
    await enviarLista(tenant, paraWa, msg.cuerpo, msg.textoBoton ?? "Ver opciones", msg.opciones);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Descarga de media (audio/imagen) desde la Graph API.
//    Paso 1: GET /{mediaId} → devuelve la URL temporal del archivo.
//    Paso 2: GET de esa URL con el token → devuelve los bytes.
// ─────────────────────────────────────────────────────────────────────────────
export async function descargarMedia(
  tenant: Tenant,
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("Falta access token de WhatsApp para el tenant " + tenant.id);

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    const detalle = await metaRes.text();
    throw new Error(`Error obteniendo URL de media ${mediaId} (${metaRes.status}): ${detalle.slice(0, 140)}`);
  }
  const { url, mime_type } = (await metaRes.json()) as { url: string; mime_type: string };

  const archivoRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!archivoRes.ok) throw new Error(`Error descargando media (${archivoRes.status})`);
  const buffer = Buffer.from(await archivoRes.arrayBuffer());
  return { buffer, mimeType: mime_type ?? "application/octet-stream" };
}

/**
 * Descarga una foto de WhatsApp y la devuelve como data URL
 * ("data:image/jpeg;base64,…"), lista para adjuntarla a un mensaje multimodal de
 * OpenAI (visión, C1.5) o para guardarla/mostrarla tal cual en el panel.
 */
export async function descargarImagenComoDataUrl(tenant: Tenant, mediaId: string): Promise<string> {
  const { buffer, mimeType } = await descargarMedia(tenant, mediaId);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Envío de un MENSAJE DE PLANTILLA (template).
//    Necesario para iniciar conversación FUERA de la ventana de 24 h de Meta
//    (caso típico: recordatorios de cita). La plantilla debe estar APROBADA
//    en el WhatsApp Manager del negocio y sus variables {{1}}, {{2}}… se
//    pasan en `parametros` (en orden).
// ─────────────────────────────────────────────────────────────────────────────
export async function enviarPlantilla(
  tenant: Tenant,
  paraWa: string,
  nombrePlantilla: string,
  idioma: string,
  parametros: string[],
  // Categoría de la plantilla ante Meta (para el contador de uso, Carril D 0.2):
  // "marketing" = campañas segmentadas (C3.2); "utilidad" = recordatorios fuera de
  // la ventana de 24 h (default, ya que es el caso más frecuente hoy).
  categoria: "marketing" | "utilidad" = "utilidad",
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "template",
      template: {
        name: nombrePlantilla,
        language: { code: idioma },
        components: parametros.length
          ? [
              {
                type: "body",
                parameters: parametros.map((texto) => ({ type: "text", text: texto })),
              },
            ]
          : undefined,
      },
    },
    "enviando plantilla WhatsApp",
    categoria,
  );
}
