import { log } from "./log";
import { captureError } from "./sentry";
import { timeoutSignal } from "../net/timeouts";
import { PRODUCT_SLUG } from "../brand";

// ─────────────────────────────────────────────────────────────────────────────
// Alertas al operador de la PLATAFORMA (Selyon), no al dueño del negocio.
//
// POR QUÉ: si el servicio de un negocio se queda mudo (cola atascada, token de un
// proveedor revocado, webhooks que dejaron de llegar, tope del plan agotado) nadie se
// entera: /health solo mira la base y Sentry es no-op sin SENTRY_DSN. Este módulo es el
// ÚNICO canal de salida de esas señales; los detectores viven en cada módulo.
//
// Canal simple y SIN dependencias nuevas, hasta cuatro salidas a la vez:
//   1) log estructurado (`log.ts`, una línea JSON — siempre, aunque no haya nada más
//      configurado: es lo mínimo que se ve en `pm2 logs`);
//   2) Sentry (`captureError`, no-op sin SENTRY_DSN);
//   3) webhook HTTP genérico opcional (`ALERTS_WEBHOOK_URL`): POST con JSON
//      `{ text, content }` — `text` lo entiende un Incoming Webhook de Slack y `content`
//      uno de Discord, así la misma URL sirve para cualquiera de los dos sin configurar
//      el "formato";
//   4) Telegram opcional (`ALERTS_TELEGRAM_BOT_TOKEN` + `ALERTS_TELEGRAM_CHAT_ID`): un
//      `sendMessage` de la Bot API con `fetch` (texto plano, sin parse_mode: nada que
//      escapar). Es el canal que recibe la persona de guardia en el teléfono, también de
//      noche (DEPLOY.md §22). Con una sola de las dos variables no sale nada por acá.
//
// Producción con solo el log (sin Sentry, webhook ni Telegram) = nadie se entera: el
// arranque lo advierte (`alertChannelsWarning`, desde productionConfigWarnings) pero no
// frena el proceso (decisión del usuario, 2026-10-31).
//
// Deduplicación: una alerta por (tipo, negocio) cada `ALERTS_COOLDOWN_MIN` (default 60)
// — los detectores corren cada pocos minutos y sin esto el mismo problema mandaría un
// mensaje por tick. Cada llamada puede pedir un cooldown propio (p. ej. una cuota
// agotada, que no cambia en todo el mes, usa 24 h). El estado del cooldown es de PROCESO
// (en memoria): con N réplicas, cada una deduplica lo suyo — aceptable porque los
// detectores periódicos corren solo en el líder (`startLeaderLoop`).
//
// Sin datos personales: los mensajes solo llevan tenantId, conteos y tiempos (nunca
// teléfonos ni contenido de conversaciones).
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo de alerta en snake_case, p. ej. "queue_stuck" o "whatsapp_token_invalid". Lo define cada módulo. */
export type AlertType = string;

/** Alerta de prueba (`scripts/sendTestAlert.ts`): verifica que los canales configurados llegan. */
export const TEST_ALERT: AlertType = "test_alert";

export type AlertSeverity = "critical" | "warning";

export interface Alert {
  type: AlertType;
  /** null/undefined = alerta global de la plataforma (no de un negocio puntual). */
  tenantId?: string | null;
  severity: AlertSeverity;
  /** Texto corto y legible para un humano. SIN datos personales. */
  message: string;
  /** Datos extra para el log/Sentry (conteos, umbrales). SIN datos personales. */
  data?: Record<string, unknown>;
  /** Cooldown propio de esta alerta; si no se da, `ALERTS_COOLDOWN_MIN`. */
  cooldownMs?: number;
}

function defaultCooldownMs(): number {
  const n = Number(process.env.ALERTS_COOLDOWN_MIN);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 60_000;
}

const DELIVERY_TIMEOUT_MS = 5_000;
// Discord corta en 2000 caracteres, Telegram en 4096 y Slack trunca mensajes muy largos:
// con este tope el texto entra en todos sin que el envío falle por tamaño.
const MAX_TEXT_LENGTH = 1_900;
const TELEGRAM_API = "https://api.telegram.org";

/** Última vez (epoch ms) que salió una alerta por cada clave (tipo, negocio). */
const lastAlertByKey = new Map<string, number>();

type WebhookSender = (url: string, body: { text: string; content: string }) => Promise<void>;
type TelegramSender = (botToken: string, chatId: string, text: string) => Promise<void>;

async function sendWebhook(url: string, body: { text: string; content: string }): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook de alertas respondió ${res.status}`);
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  // El token va en la ruta (así es la Bot API): esta URL NUNCA se loguea.
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: timeoutSignal(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Telegram respondió ${res.status}`);
}

let webhookSender: WebhookSender = sendWebhook;
let telegramSender: TelegramSender = sendTelegram;

type Env = Record<string, string | undefined>;

/** Bot y chat de Telegram, solo si están los DOS. */
function telegramConfig(env: Env = process.env): { botToken: string; chatId: string } | null {
  const botToken = env.ALERTS_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.ALERTS_TELEGRAM_CHAT_ID?.trim();
  return botToken && chatId ? { botToken, chatId } : null;
}

/** Resultado de un envío en segundo plano (para el script de prueba y los tests). */
export interface AlertDelivery {
  channel: "webhook" | "telegram";
  ok: boolean;
  /** Mensaje del error, SIN secretos (el token de Telegram se enmascara). */
  error?: string;
}

/** Envíos en vuelo: `flushAlerts` los espera (un script corto sale antes si no). */
const inFlight = new Set<Promise<AlertDelivery>>();

function deliver(channel: AlertDelivery["channel"], a: Alert, send: () => Promise<void>, secret?: string): void {
  // El envío arranca YA (sincrónico hasta su primer await); un throw sincrónico se trata como rechazo.
  let started: Promise<void>;
  try {
    started = send();
  } catch (e) {
    started = Promise.reject(e);
  }
  const p: Promise<AlertDelivery> = started.then(
    () => ({ channel, ok: true }),
    (e: unknown) => {
      let error = e instanceof Error ? e.message : String(e);
      if (secret) error = error.split(secret).join("***");
      log.warn(`platform_alert_${channel}_failed`, { type: a.type, tenantId: a.tenantId ?? null, error });
      return { channel, ok: false, error };
    },
  );
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * Espera los envíos en vuelo (webhook y Telegram) y devuelve cómo salió cada uno. El
 * proceso del servidor no lo necesita; un script de vida corta sí (si no, sale antes).
 */
export async function flushAlerts(): Promise<AlertDelivery[]> {
  return Promise.all([...inFlight]);
}

function keyOf(type: AlertType, tenantId?: string | null): string {
  return `${type}:${tenantId ?? "*"}`;
}

/** Texto plano del mensaje para Slack/Discord/Telegram. */
function webhookText(a: Alert): string {
  const icon = a.severity === "critical" ? "🚨" : "⚠️";
  const env = process.env.NODE_ENV ?? "development";
  const who = a.tenantId ? ` · tenant ${a.tenantId}` : "";
  return `${icon} [${PRODUCT_SLUG}/${env}] ${a.type}${who}: ${a.message}`.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Emite una alerta a la plataforma por todos los canales configurados, salvo que la misma
 * (tipo, negocio) ya haya salido dentro de su cooldown. Devuelve `true` si se emitió,
 * `false` si la absorbió la deduplicación.
 *
 * NUNCA lanza ni bloquea: el webhook se manda en segundo plano y su fallo solo se loguea.
 * Se puede llamar desde el camino caliente.
 */
export function alertPlatform(a: Alert, now: number = Date.now()): boolean {
  const key = keyOf(a.type, a.tenantId);
  const cooldown = a.cooldownMs ?? defaultCooldownMs();
  const last = lastAlertByKey.get(key);
  if (last !== undefined && now - last < cooldown) return false;
  lastAlertByKey.set(key, now);

  const fields = { type: a.type, tenantId: a.tenantId ?? null, severity: a.severity, message: a.message, ...a.data };
  if (a.severity === "critical") log.error("platform_alert", fields);
  else log.warn("platform_alert", fields);

  captureError(new Error(`[alerta ${a.type}] ${a.message}`), { module: "alerts", ...fields });

  const text = webhookText(a);
  const url = process.env.ALERTS_WEBHOOK_URL;
  if (url) deliver("webhook", a, () => webhookSender(url, { text, content: text }));
  const telegram = telegramConfig();
  if (telegram) deliver("telegram", a, () => telegramSender(telegram.botToken, telegram.chatId, text), telegram.botToken);
  return true;
}

/**
 * Olvida el cooldown de una (tipo, negocio): la próxima ocurrencia vuelve a alertar de
 * inmediato. Se usa cuando el problema se RESUELVE (p. ej. el token volvió a funcionar),
 * para que una recaída no quede silenciada por el cooldown viejo.
 */
export function forgetAlert(type: AlertType, tenantId?: string | null): void {
  lastAlertByKey.delete(keyOf(type, tenantId));
}

/** Canales por los que sale una alerta (siempre el log; Sentry, webhook y Telegram si están). Para el arranque. */
export function configuredAlertChannels(env: Env = process.env): string[] {
  const channels = ["log"];
  if (env.SENTRY_DSN?.trim()) channels.push("sentry");
  if (env.ALERTS_WEBHOOK_URL?.trim()) channels.push("webhook");
  if (telegramConfig(env)) channels.push("telegram");
  return channels;
}

/**
 * Aviso de arranque si las alertas no le llegan a nadie (null = bien). Solo en
 * producción: solo el log (nadie mira `pm2 logs` de noche), o Telegram a medio
 * configurar. No frena el arranque: lo suman productionConfigWarnings y server.ts.
 */
export function alertChannelsWarning(env: Env = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  const halfTelegram = !telegramConfig(env) && Boolean(env.ALERTS_TELEGRAM_BOT_TOKEN?.trim() || env.ALERTS_TELEGRAM_CHAT_ID?.trim());
  if (halfTelegram) {
    return "Alertas por Telegram a medio configurar: faltan ALERTS_TELEGRAM_BOT_TOKEN o ALERTS_TELEGRAM_CHAT_ID (hacen falta los dos; DEPLOY.md §22).";
  }
  if (configuredAlertChannels(env).length > 1) return null;
  return "Alertas a la plataforma solo por log: nadie se entera si el bot queda mudo. Configurá ALERTS_TELEGRAM_BOT_TOKEN + ALERTS_TELEGRAM_CHAT_ID (o ALERTS_WEBHOOK_URL / SENTRY_DSN) y mandá una alerta de prueba (DEPLOY.md §22).";
}

/** Solo para tests: limpia el estado de deduplicación. */
export function _resetAlertsForTests(): void {
  lastAlertByKey.clear();
}

/** Solo para tests: reemplaza el POST del webhook (null = vuelve al real). */
export function _setWebhookSenderForTests(fn: WebhookSender | null): void {
  webhookSender = fn ?? sendWebhook;
}

/** Solo para tests: reemplaza el envío a Telegram (null = vuelve al real). */
export function _setTelegramSenderForTests(fn: TelegramSender | null): void {
  telegramSender = fn ?? sendTelegram;
}
