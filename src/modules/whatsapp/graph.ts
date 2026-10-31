import { msFromEnv, timeoutSignal } from "../../platform/net/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Cliente de la Graph API de Meta (WhatsApp Cloud API), portado de
// legacy/src/whatsapp/{client,embeddedSignup}.ts. Solo `fetch` (inyectable: los tests
// nunca salen a la red).
//
// Reintentos: Meta a veces devuelve hipos momentáneos (`is_transient`, códigos 1, 2, 4,
// 131000…), rate limits (429) y 5xx. Cada envío se reintenta en caliente hasta 3 veces con
// backoff corto; si el problema dura más, el error sale con `transient: true` y la COLA
// reintenta el job entero (src/platform/net/transient.ts lee esa marca). Un error
// permanente (token inválido, número bloqueado, parámetros mal) sale con `transient: false`.
//
// Token: cada llamada usa el token del canal (descifrado por quien llama). Un 401 o el
// código 190 de Graph = el token ya no sirve: se avisa por `onTokenStatus` (el módulo marca
// el canal y alerta a la plataforma); una respuesta OK lo da por bueno otra vez.
// ─────────────────────────────────────────────────────────────────────────────

/** Versión de la Graph API (cambia con el tiempo: confirmá la vigente en la documentación de Meta). */
export const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION?.trim() || "v21.0";
const GRAPH_TIMEOUT_MS = msFromEnv("GRAPH_TIMEOUT_MS", 15_000);
/** Descarga de fotos y audios: viajan bytes, no JSON. */
const GRAPH_MEDIA_TIMEOUT_MS = msFromEnv("GRAPH_MEDIA_TIMEOUT_MS", 30_000);
/** Tope de una foto o audio descargado (WhatsApp permite hasta 16 MB de audio). */
const MEDIA_MAX_BYTES = msFromEnv("WHATSAPP_MEDIA_MAX_BYTES", 16 * 1024 * 1024);
/**
 * Tope propio de un AUDIO (`WHATSAPP_AUDIO_MAX_BYTES`, default 3 MB): una nota de voz de
 * WhatsApp (opus, ~16 kbps) de 2 min pesa ~250 KB y un mp3 de 2 min a 192 kbps ~2,9 MB. Lo
 * más grande ni se baja (horas de audio que Whisper cobraría por minuto); el tope de
 * DURACIÓN (`AGENT_AUDIO_MAX_SEC`) se aplica después, en el pipeline (./media.ts).
 */
const AUDIO_MAX_BYTES = msFromEnv("WHATSAPP_AUDIO_MAX_BYTES", 3 * 1024 * 1024);

const MAX_SEND_ATTEMPTS = 3;
const TOKEN_INVALID_CODE = 190;
// Códigos de Meta transitorios aunque lleguen con HTTP 400/200 (ver legacy client.ts).
const TRANSIENT_META_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 133016]);

/** Lo mínimo para hablar con Graph en nombre de un número conectado. */
export interface ChannelCredentials {
  channelId: string;
  businessId: string;
  phoneNumberId: string;
  /** Token del WABA, YA descifrado. Nunca se loguea. */
  accessToken: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

/** Plantilla aprobada en Meta, con sus variables del cuerpo y los payloads de sus botones. */
export interface TemplateMessage {
  name: string;
  language: string;
  /** Variables {{1}}, {{2}}… del cuerpo, en orden. */
  bodyParams?: string[];
  /** Payload de cada botón de respuesta rápida (índice 0, 1…): vuelve en el tap del cliente. */
  quickReplyPayloads?: string[];
}

export interface SendResult {
  /** id del mensaje en WhatsApp ("wamid…"), si Meta lo devolvió. */
  messageId: string | null;
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhone: string | null;
  verifiedName: string | null;
}

/** Lo que el módulo usa para mensajear (los tests lo reemplazan por un doble). */
export interface WhatsAppApi {
  sendText(channel: ChannelCredentials, to: string, text: string): Promise<SendResult>;
  /** Mensaje interactivo con hasta 3 botones de respuesta rápida. */
  sendButtons(channel: ChannelCredentials, to: string, body: string, buttons: ReplyButton[]): Promise<SendResult>;
  sendTemplate(channel: ChannelCredentials, to: string, template: TemplateMessage): Promise<SendResult>;
  downloadMedia(channel: ChannelCredentials, mediaId: string): Promise<DownloadedMedia>;
  /** Datos del número (sirve de prueba de que el token funciona). */
  getPhoneNumber(channel: ChannelCredentials): Promise<PhoneNumberInfo>;
}

/** Alta del número con el Embedded Signup de Meta. */
export interface MetaSignupApi {
  /** Canjea el `code` del popup por el token del WABA del negocio. */
  exchangeCode(code: string): Promise<string>;
  /** WABA a los que el token tiene acceso (sale de los permisos granulares del token). */
  listWhatsAppAccounts(token: string): Promise<string[]>;
  listPhoneNumbers(wabaId: string, token: string): Promise<PhoneNumberInfo[]>;
  /** Suscribe nuestra app a los webhooks del WABA. Best-effort: false si falla. */
  subscribeApp(wabaId: string, token: string): Promise<boolean>;
  /** Registra el número en la Cloud API (requiere WHATSAPP_REGISTER_PIN). Best-effort. */
  registerNumber(phoneNumberId: string, token: string): Promise<boolean>;
}

/** Tope de bytes de un adjunto según su tipo. */
function maxBytesFor(mimeType: string): number {
  return mimeType.trim().toLowerCase().startsWith("audio/") ? Math.min(AUDIO_MAX_BYTES, MEDIA_MAX_BYTES) : MEDIA_MAX_BYTES;
}

/** Error de Graph con la marca de si vale la pena reintentar más tarde. */
export class GraphError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;
  /** Código de error de Meta (`error.code`), si vino. */
  readonly code: number | null;
  /** true si Meta rechazó el token (401 / código 190). */
  readonly tokenInvalid: boolean;

  constructor(message: string, options: { status?: number; transient: boolean; code?: number | null; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GraphError";
    this.status = options.status;
    this.transient = options.transient;
    this.code = options.code ?? null;
    this.tokenInvalid = options.status === 401 || options.code === TOKEN_INVALID_CODE;
  }
}

/** El adjunto pasa el tope de bytes (el de media o, si es audio, el de audio). No es transitorio. */
export class MediaTooLargeError extends GraphError {
  readonly bytes: number;
  readonly maxBytes: number;
  readonly mimeType: string;

  constructor(mimeType: string, bytes: number, maxBytes: number) {
    super(`Graph media: archivo demasiado grande (${bytes} bytes, máximo ${maxBytes})`, { transient: false });
    this.name = "MediaTooLargeError";
    this.mimeType = mimeType;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export interface GraphApiOptions {
  fetch?: typeof fetch;
  version?: string;
  /** Espera antes del reintento `n` (1 = tras el primer fallo). Default 500 ms, 1,5 s. */
  retryDelayMs?: (attempt: number) => number;
  /** Avisa si el token del canal funcionó (true) o Meta lo rechazó (false). Nunca debe lanzar. */
  onTokenStatus?: (channel: Pick<ChannelCredentials, "channelId" | "businessId">, valid: boolean) => void;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; is_transient?: boolean };
}

function parseMetaError(detail: string): { code: number | null; transient: boolean; message: string | null } {
  try {
    const err = (JSON.parse(detail) as MetaErrorBody)?.error;
    if (!err) return { code: null, transient: false, message: null };
    const code = typeof err.code === "number" ? err.code : null;
    return { code, transient: err.is_transient === true || (code !== null && TRANSIENT_META_CODES.has(code)), message: err.message ?? null };
  } catch {
    return { code: null, transient: false, message: null };
  }
}

const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultRetryDelay = (attempt: number) => Math.min(500 * 3 ** (attempt - 1), 5_000);

/** Solo dígitos (E.164 sin "+"), como lo espera Graph. */
export function toWhatsAppNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Crea el cliente real de Graph. */
export function createGraphApi(options: GraphApiOptions = {}): WhatsAppApi & MetaSignupApi {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base = `https://graph.facebook.com/${options.version ?? GRAPH_API_VERSION}`;
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay;

  function reportToken(channel: ChannelCredentials, valid: boolean): void {
    try {
      options.onTokenStatus?.({ channelId: channel.channelId, businessId: channel.businessId }, valid);
    } catch {
      // La observabilidad nunca rompe el envío.
    }
  }

  /** Error de una respuesta no-OK (y aviso del token si corresponde). */
  async function failure(res: Response, label: string, channel: ChannelCredentials | null): Promise<GraphError> {
    const detail = await res.text().catch(() => "");
    const meta = parseMetaError(detail);
    const error = new GraphError(`Graph ${label} (${res.status}): ${(meta.message ?? detail).slice(0, 200)}`, {
      status: res.status,
      code: meta.code,
      transient: transientStatus(res.status) || meta.transient,
    });
    if (channel && error.tokenInvalid) reportToken(channel, false);
    return error;
  }

  /** fetch con timeout; un corte de red o un timeout es transitorio. */
  async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
    } catch (e) {
      throw new GraphError(`Graph sin respuesta: ${e instanceof Error ? e.message : String(e)}`, { transient: true, cause: e });
    }
  }

  /** POST /{phone_number_id}/messages con reintentos en caliente ante lo transitorio. */
  async function postMessage(channel: ChannelCredentials, content: Record<string, unknown>, label: string): Promise<SendResult> {
    const url = `${base}/${encodeURIComponent(channel.phoneNumberId)}/messages`;
    const body = JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...content });
    let last: GraphError | null = null;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await call(url, { method: "POST", headers: { Authorization: `Bearer ${channel.accessToken}`, "Content-Type": "application/json" }, body }, GRAPH_TIMEOUT_MS);
      } catch (e) {
        last = e as GraphError;
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw last;
      }
      if (res.ok) {
        reportToken(channel, true);
        const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
        return { messageId: json?.messages?.[0]?.id ?? null };
      }
      last = await failure(res, label, channel);
      if (last.transient && attempt < MAX_SEND_ATTEMPTS) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw last;
    }
    throw last ?? new GraphError(`Graph ${label}: sin intentos`, { transient: true });
  }

  async function getJson<T>(url: string, token: string, label: string, channel: ChannelCredentials | null): Promise<T> {
    const res = await call(url, { headers: { Authorization: `Bearer ${token}` } }, GRAPH_TIMEOUT_MS);
    if (!res.ok) throw await failure(res, label, channel);
    if (channel) reportToken(channel, true);
    return (await res.json()) as T;
  }

  return {
    sendText(channel, to, text) {
      // 4096 = límite de WhatsApp para un texto.
      return postMessage(channel, { to: toWhatsAppNumber(to), type: "text", text: { body: text.slice(0, 4096), preview_url: false } }, "texto");
    },

    sendButtons(channel, to, body, buttons) {
      return postMessage(
        channel,
        {
          to: toWhatsAppNumber(to),
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: body.slice(0, 1024) },
            action: {
              // Límites de Meta: 3 botones, id ≤ 256, título ≤ 20.
              buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
            },
          },
        },
        "botones",
      );
    },

    sendTemplate(channel, to, template) {
      const components: Record<string, unknown>[] = [];
      if (template.bodyParams?.length) {
        components.push({ type: "body", parameters: template.bodyParams.map((t) => ({ type: "text", text: t.slice(0, 1024) })) });
      }
      template.quickReplyPayloads?.forEach((payload, index) => {
        components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] });
      });
      return postMessage(
        channel,
        {
          to: toWhatsAppNumber(to),
          type: "template",
          template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) },
        },
        "plantilla",
      );
    },

    async downloadMedia(channel, mediaId) {
      const meta = await getJson<{ url?: string; mime_type?: string; file_size?: number }>(
        `${base}/${encodeURIComponent(mediaId)}`,
        channel.accessToken,
        "media",
        channel,
      );
      if (!meta.url) throw new GraphError("Graph media: sin URL de descarga", { transient: false });
      // Se chequea ANTES de bajar (con el tamaño que declara Meta) y otra vez sobre los bytes.
      const declaredMime = meta.mime_type ?? "";
      if (typeof meta.file_size === "number" && meta.file_size > maxBytesFor(declaredMime)) {
        throw new MediaTooLargeError(declaredMime, meta.file_size, maxBytesFor(declaredMime));
      }
      const res = await call(meta.url, { headers: { Authorization: `Bearer ${channel.accessToken}` } }, GRAPH_MEDIA_TIMEOUT_MS);
      if (!res.ok) throw await failure(res, "descarga de media", channel);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mimeType = meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream";
      if (buffer.length > maxBytesFor(mimeType)) throw new MediaTooLargeError(mimeType, buffer.length, maxBytesFor(mimeType));
      return { buffer, mimeType };
    },

    async getPhoneNumber(channel) {
      const json = await getJson<{ id?: string; display_phone_number?: string; verified_name?: string }>(
        `${base}/${encodeURIComponent(channel.phoneNumberId)}?fields=display_phone_number,verified_name`,
        channel.accessToken,
        "número",
        channel,
      );
      return { id: json.id ?? channel.phoneNumberId, displayPhone: json.display_phone_number ?? null, verifiedName: json.verified_name ?? null };
    },

    async exchangeCode(code) {
      const appId = process.env.META_APP_ID?.trim();
      const secret = process.env.WHATSAPP_APP_SECRET?.trim();
      if (!appId || !secret) throw new GraphError("Embedded Signup sin configurar (META_APP_ID / WHATSAPP_APP_SECRET)", { transient: false });
      // El flujo de código del SDK no lleva redirect_uri: el token se emite contra la app.
      const q = new URLSearchParams({ client_id: appId, client_secret: secret, code });
      const res = await call(`${base}/oauth/access_token?${q}`, { method: "GET" }, GRAPH_TIMEOUT_MS);
      if (!res.ok) throw await failure(res, "canje del código", null);
      const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
      if (!json?.access_token) throw new GraphError("Graph canje del código: sin access_token", { transient: false });
      return json.access_token;
    },

    async listWhatsAppAccounts(token) {
      const appId = process.env.META_APP_ID?.trim();
      const secret = process.env.WHATSAPP_APP_SECRET?.trim();
      if (!appId || !secret) return [];
      const q = new URLSearchParams({ input_token: token, access_token: `${appId}|${secret}` });
      const res = await call(`${base}/debug_token?${q}`, { method: "GET" }, GRAPH_TIMEOUT_MS);
      if (!res.ok) throw await failure(res, "debug_token", null);
      const json = (await res.json().catch(() => null)) as {
        data?: { granular_scopes?: { scope?: string; target_ids?: string[] }[] };
      } | null;
      const ids = new Set<string>();
      for (const s of json?.data?.granular_scopes ?? []) {
        if (s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging") {
          for (const id of s.target_ids ?? []) ids.add(String(id));
        }
      }
      return [...ids];
    },

    async listPhoneNumbers(wabaId, token) {
      const json = await getJson<{ data?: { id?: string; display_phone_number?: string; verified_name?: string }[] }>(
        `${base}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`,
        token,
        "números del WABA",
        null,
      );
      return (json.data ?? [])
        .filter((n) => n.id)
        .map((n) => ({ id: String(n.id), displayPhone: n.display_phone_number ?? null, verifiedName: n.verified_name ?? null }));
    },

    async subscribeApp(wabaId, token) {
      try {
        const res = await call(`${base}/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, GRAPH_TIMEOUT_MS);
        return res.ok;
      } catch {
        return false;
      }
    },

    async registerNumber(phoneNumberId, token) {
      const pin = process.env.WHATSAPP_REGISTER_PIN?.trim();
      if (!pin) return false;
      try {
        const res = await call(
          `${base}/${encodeURIComponent(phoneNumberId)}/register`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", pin }),
          },
          GRAPH_TIMEOUT_MS,
        );
        // Si ya estaba registrado Meta responde error, pero la conexión igual sirve.
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/** Config PÚBLICA del Embedded Signup para el panel (nunca el secret). null si falta algo. */
export function embeddedSignupConfig(): { appId: string; configId: string; graphVersion: string } | null {
  const appId = process.env.META_APP_ID?.trim();
  const configId = process.env.META_ES_CONFIG_ID?.trim();
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!appId || !configId || !secret) return null;
  return { appId, configId, graphVersion: GRAPH_API_VERSION };
}
