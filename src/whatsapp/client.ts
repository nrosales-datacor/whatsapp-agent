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
    if (!phoneNumberId || !clienteWa) return null;
    return { phoneNumberId, clienteWa, texto, esTexto, messageId: msg.id ? String(msg.id) : undefined };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Envío de un mensaje de texto al cliente.
// ─────────────────────────────────────────────────────────────────────────────
export async function enviarTexto(tenant: Tenant, paraWa: string, texto: string): Promise<void> {
  const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("Falta access token de WhatsApp para el tenant " + tenant.id);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${tenant.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: paraWa,
      type: "text",
      text: { body: texto.slice(0, 4096) }, // límite de WhatsApp
    }),
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`Error enviando WhatsApp (${res.status}): ${detalle}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Envío de un MENSAJE DE PLANTILLA (template).
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
  const token = tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("Falta access token de WhatsApp para el tenant " + tenant.id);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${tenant.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
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
    }),
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`Error enviando plantilla WhatsApp (${res.status}): ${detalle}`);
  }
}
