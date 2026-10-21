// ─────────────────────────────────────────────────────────────────────────────
// Lectura del payload del webhook de Meta, portada de legacy/src/whatsapp/client.ts
// (`separarPayloadWebhook` + `clasificarEntrante`). Funciones puras: nada de red ni base.
//
//   • Un POST de Meta puede traer varios `entry` (uno por WABA: varios negocios de la
//     misma app), varios `changes` y varios `messages`. `splitWebhookPayload` lo parte en
//     pedazos de UN mensaje cada uno, conservando la forma original (con su `metadata` y
//     `contacts`), así cada pedazo se rutea, deduplica y guarda (o va a `raw_webhooks`)
//     por separado. Un `change` sin mensajes (estados entregado/leído) sale como un
//     pedazo propio que se clasifica "ignorable".
//   • `classifyWebhookPayload` distingue tres casos: un mensaje que sabemos leer, algo
//     que no interesa (estados, reacciones) y una forma desconocida (se guarda cruda).
//
// Nunca se confía en el payload: el remitente queda solo con dígitos y los textos se
// recortan.
// ─────────────────────────────────────────────────────────────────────────────

export type InboundKind = "text" | "image" | "audio" | "document" | "contact" | "unsupported";

export interface InboundMessage {
  /** Número del negocio al que llegó (rutea al canal). */
  phoneNumberId: string;
  /** Remitente, solo dígitos (E.164 sin "+"). */
  from: string;
  /** Nombre del perfil de WhatsApp del cliente, si vino. */
  profileName: string | null;
  /** id del mensaje en WhatsApp ("wamid…"): la idempotencia de la ingesta. */
  waMessageId: string;
  kind: InboundKind;
  /**
   * Lo que "dijo" el cliente: el texto, la leyenda de la foto, la frase de un botón
   * tocado o una ubicación descrita. Vacío para un audio o una foto sin leyenda.
   */
  text: string;
  /** id del adjunto en Graph (foto, audio o documento). */
  mediaId?: string;
  mimeType?: string;
  /** id crudo del botón tocado (nuestro `tipo|arg` o el payload de una plantilla). */
  interactiveId?: string;
  /** Texto visible del botón de una plantilla (por si el payload no sigue nuestra convención). */
  buttonText?: string;
  fileName?: string;
  contactName?: string;
}

export type ClassifiedPayload = { type: "message"; message: InboundMessage } | { type: "ignorable" } | { type: "unparseable" };

const MAX_TEXT = 4096;

/** Parte un POST de Meta en pedazos de un solo mensaje (ver cabecera). */
export function splitWebhookPayload(body: unknown): unknown[] {
  const b = body as any;
  const entries = b?.entry;
  if (!Array.isArray(entries) || entries.length === 0) return [body];
  const parts: unknown[] = [];
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes) || changes.length === 0) {
      parts.push({ ...b, entry: [entry] });
      continue;
    }
    for (const change of changes) {
      const value = change?.value;
      const messages = value?.messages;
      if (!Array.isArray(messages) || messages.length <= 1) {
        parts.push({ ...b, entry: [{ ...entry, changes: [change] }] });
        continue;
      }
      for (const msg of messages) {
        parts.push({ ...b, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [msg] } }] }] });
      }
    }
  }
  return parts;
}

/** `phone_number_id` y `wamid` de un pedazo, aunque no se pueda leer el resto (para `raw_webhooks`). */
export function payloadIds(part: unknown): { phoneNumberId: string | null; waMessageId: string | null } {
  try {
    const value = (part as any)?.entry?.[0]?.changes?.[0]?.value;
    const pnid = value?.metadata?.phone_number_id;
    const id = value?.messages?.[0]?.id;
    return { phoneNumberId: pnid ? String(pnid) : null, waMessageId: id ? String(id) : null };
  } catch {
    return { phoneNumberId: null, waMessageId: null };
  }
}

/** Clasifica un pedazo de UN mensaje (ver cabecera). */
export function classifyWebhookPayload(part: unknown): ClassifiedPayload {
  try {
    const value = (part as any)?.entry?.[0]?.changes?.[0]?.value;
    if (value == null) return { type: "unparseable" };
    const msg = value.messages?.[0];
    // Sin mensaje: un estado (entregado/leído) u otro evento. Alto volumen, no interesa.
    if (!msg) return { type: "ignorable" };
    // Una reacción (👍 a un mensaje del bot) es cortesía: ni respuesta ni aviso al operador.
    if (msg.type === "reaction") return { type: "ignorable" };

    const phoneNumberId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : "";
    const from = String(msg.from ?? "").replace(/\D/g, "");
    const waMessageId = msg.id ? String(msg.id) : "";
    if (!phoneNumberId || !from || !waMessageId) return { type: "unparseable" };

    const contact = Array.isArray(value.contacts) ? value.contacts.find((c: any) => String(c?.wa_id ?? "") === from) ?? value.contacts[0] : null;
    const profileName = contact?.profile?.name ? String(contact.profile.name).trim().slice(0, 120) || null : null;
    const base = { phoneNumberId, from, profileName, waMessageId };

    switch (msg.type) {
      case "text":
        return { type: "message", message: { ...base, kind: "text", text: String(msg.text?.body ?? "").slice(0, MAX_TEXT) } };
      case "image":
        return {
          type: "message",
          message: {
            ...base,
            kind: "image",
            text: msg.image?.caption ? String(msg.image.caption).slice(0, MAX_TEXT) : "",
            mediaId: msg.image?.id ? String(msg.image.id) : undefined,
            mimeType: msg.image?.mime_type ? String(msg.image.mime_type) : undefined,
          },
        };
      case "audio":
        return {
          type: "message",
          message: {
            ...base,
            kind: "audio",
            text: "",
            mediaId: msg.audio?.id ? String(msg.audio.id) : undefined,
            mimeType: msg.audio?.mime_type ? String(msg.audio.mime_type) : undefined,
          },
        };
      case "document":
        return {
          type: "message",
          message: {
            ...base,
            kind: "document",
            text: msg.document?.caption ? String(msg.document.caption).slice(0, MAX_TEXT) : "",
            mediaId: msg.document?.id ? String(msg.document.id) : undefined,
            mimeType: msg.document?.mime_type ? String(msg.document.mime_type) : undefined,
            fileName: msg.document?.filename ? String(msg.document.filename).slice(0, 200) : undefined,
          },
        };
      case "contacts": {
        const list = Array.isArray(msg.contacts) ? msg.contacts : [];
        const first = list[0]?.name?.formatted_name ? String(list[0].name.formatted_name).slice(0, 120) : "";
        const contactName = first ? (list.length > 1 ? `${first} (+${list.length - 1} más)` : first) : undefined;
        return { type: "message", message: { ...base, kind: "contact", text: "", contactName } };
      }
      case "location": {
        // Se trata como texto legible: el agente la recibe como si el cliente la hubiera escrito.
        const { latitude, longitude, name, address } = msg.location ?? {};
        const parts = [`[ubicación compartida] lat: ${latitude}, lon: ${longitude}`];
        if (name) parts.push(`nombre: ${String(name).slice(0, 200)}`);
        if (address) parts.push(`dirección: ${String(address).slice(0, 300)}`);
        return { type: "message", message: { ...base, kind: "text", text: parts.join(", ") } };
      }
      case "interactive": {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        const interactiveId = reply?.id ? String(reply.id).slice(0, 256) : undefined;
        const title = reply?.title ? String(reply.title).slice(0, 200) : "";
        const text = describeInteractiveReply(interactiveId ?? "", title);
        if (!text) return { type: "message", message: { ...base, kind: "unsupported", text: "" } };
        return { type: "message", message: { ...base, kind: "text", text, interactiveId } };
      }
      case "button": {
        // Botón de respuesta rápida de una PLANTILLA aprobada: la carga viaja en `button.payload`.
        const interactiveId = msg.button?.payload ? String(msg.button.payload).slice(0, 256) : undefined;
        const buttonText = msg.button?.text ? String(msg.button.text).slice(0, 200) : "";
        const text = describeInteractiveReply(interactiveId ?? "", buttonText);
        if (!text) return { type: "message", message: { ...base, kind: "unsupported", text: "" } };
        return { type: "message", message: { ...base, kind: "text", text, interactiveId, buttonText: buttonText || undefined } };
      }
      default:
        // Sticker, video y lo que venga: se guarda un marcador y se le pide que escriba.
        return { type: "message", message: { ...base, kind: "unsupported", text: "" } };
    }
  } catch {
    return { type: "unparseable" };
  }
}

// ── Protocolo de los botones (`tipo|arg`) ────────────────────────────────────
// Los ids de los botones los definimos nosotros al enviar (recordatorio: confirmar o
// cancelar la cita); al llegar la respuesta se traducen a una frase para el historial.
// Codificador y decodificador viven juntos para que no se desincronicen.

export const CONFIRM_APPOINTMENT_PREFIX = "confirm";
export const CANCEL_APPOINTMENT_PREFIX = "cancel";

/** Botones del recordatorio de cita (el título ≤ 20 caracteres, límite de Meta). */
export function reminderButtonIds(appointmentId: string): { confirm: string; cancel: string } {
  return { confirm: `${CONFIRM_APPOINTMENT_PREFIX}|${appointmentId}`, cancel: `${CANCEL_APPOINTMENT_PREFIX}|${appointmentId}` };
}

/** Frase que "diría" el cliente al tocar el botón; si el id no es nuestro, el título visible. */
export function describeInteractiveReply(id: string, title: string): string {
  const [kind] = id.split("|");
  if (kind === CONFIRM_APPOINTMENT_PREFIX) return "Confirmo mi cita ✅";
  if (kind === CANCEL_APPOINTMENT_PREFIX) return "Quiero cancelar mi cita";
  return title;
}

/** Marcador que se guarda en el historial para lo que no es texto (lo ve el operador). */
export function storedContent(message: InboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
      return message.text.trim() ? `[foto] ${message.text}` : "[foto]";
    case "audio":
      return "[audio]";
    case "document":
      return `[documento] ${message.fileName ?? "sin nombre"}`;
    case "contact":
      return `[contacto] ${message.contactName ?? "sin nombre"}`;
    case "unsupported":
      return "[multimedia]";
  }
}
