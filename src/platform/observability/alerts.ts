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
// Canal simple y SIN dependencias nuevas, tres salidas a la vez:
//   1) log estructurado (`log.ts`, una línea JSON — siempre, aunque no haya nada más
//      configurado: es lo mínimo que se ve en `pm2 logs`);
//   2) Sentry (`captureError`, no-op sin SENTRY_DSN);
//   3) webhook HTTP genérico opcional (`ALERTS_WEBHOOK_URL`): POST con JSON
//      `{ text, content }` — `text` lo entiende un Incoming Webhook de Slack y `content`
//      uno de Discord, así la misma URL sirve para cualquiera de los dos sin configurar
//      el "formato".
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

const WEBHOOK_TIMEOUT_MS = 5_000;
// Discord corta en 2000 caracteres y Slack trunca mensajes muy largos: con este tope el
// texto entra en ambos sin que el envío falle por tamaño.
const MAX_TEXT_LENGTH = 1_900;

/** Última vez (epoch ms) que salió una alerta por cada clave (tipo, negocio). */
const lastAlertByKey = new Map<string, number>();

type WebhookSender = (url: string, body: { text: string; content: string }) => Promise<void>;

async function sendWebhook(url: string, body: { text: string; content: string }): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook de alertas respondió ${res.status}`);
}

let webhookSender: WebhookSender = sendWebhook;

function keyOf(type: AlertType, tenantId?: string | null): string {
  return `${type}:${tenantId ?? "*"}`;
}

/** Texto plano del mensaje para Slack/Discord. */
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

  const url = process.env.ALERTS_WEBHOOK_URL;
  if (url) {
    const text = webhookText(a);
    void webhookSender(url, { text, content: text }).catch((e) =>
      log.warn("platform_alert_webhook_failed", {
        type: a.type,
        tenantId: a.tenantId ?? null,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
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

/** Canales por los que sale una alerta (siempre el log; Sentry y webhook si están). Para el arranque. */
export function configuredAlertChannels(): string[] {
  const channels = ["log"];
  if (process.env.SENTRY_DSN) channels.push("sentry");
  if (process.env.ALERTS_WEBHOOK_URL) channels.push("webhook");
  return channels;
}

/** Solo para tests: limpia el estado de deduplicación. */
export function _resetAlertsForTests(): void {
  lastAlertByKey.clear();
}

/** Solo para tests: reemplaza el POST del webhook (null = vuelve al real). */
export function _setWebhookSenderForTests(fn: WebhookSender | null): void {
  webhookSender = fn ?? sendWebhook;
}
