import crypto from "node:crypto";
import type { Tenant } from "../types";

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
    const esTexto = msg.type === "text";
    const texto = esTexto ? (msg.text?.body ?? "") : "";
    const audioId = msg.type === "audio" ? (msg.audio?.id ? String(msg.audio.id) : undefined) : undefined;
    if (!phoneNumberId || !clienteWa) return null;
    return { phoneNumberId, clienteWa, texto, esTexto, messageId: msg.id ? String(msg.id) : undefined, audioId };
  } catch {
    return null;
  }
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

    if (res.ok) return;

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
  return { buffer, mimeType: mime_type ?? "audio/ogg" };
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
  );
}
