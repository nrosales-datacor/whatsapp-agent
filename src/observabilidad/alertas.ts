import { log } from "./log";
import { capturarError } from "./sentry";
import { conTimeout } from "../red/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Alertas al operador de la PLATAFORMA (Selyon), no al dueño del negocio.
//
// POR QUÉ: si el bot de un cliente se queda mudo (cola atascada, token de Meta
// revocado, el número dejó de recibir webhooks, tope del plan agotado) nadie se
// enteraba: `/salud` solo marca crítico si cae la base o el caché de tenants, y
// Sentry es no-op sin SENTRY_DSN. Este módulo es el ÚNICO canal de salida de esas
// señales; los detectores viven en `vigilancia.ts` y en `whatsapp/estadoToken.ts`.
//
// Canal simple y SIN dependencias nuevas, tres salidas a la vez:
//   1) log estructurado (`log.ts`, una línea JSON — siempre, aunque no haya nada
//      más configurado: es lo mínimo que se ve en `pm2 logs`);
//   2) Sentry (`capturarError`, no-op sin SENTRY_DSN);
//   3) webhook HTTP genérico opcional (`ALERTAS_WEBHOOK_URL`): POST con JSON
//      `{ text, content }` — `text` lo entiende un Incoming Webhook de Slack y
//      `content` uno de Discord, así la misma URL sirve para cualquiera de los dos
//      sin configurar el "formato".
//
// Deduplicación: una alerta por (tipo, tenant) cada `ALERTAS_COOLDOWN_MIN`
// (default 60) — los detectores corren cada pocos minutos y sin esto el mismo
// problema mandaría un mensaje por tick. Cada llamada puede pedir un cooldown
// propio (p.ej. la cuota agotada, que no cambia en todo el mes, usa 24 h).
// El estado del cooldown es de PROCESO (en memoria), igual que los contadores de
// F3/F11/F14: con N réplicas, cada una deduplica lo suyo — aceptable porque los
// detectores periódicos corren solo en el líder (ver `iniciarVigilancia`).
//
// Sin datos personales: los mensajes solo llevan tenantId, conteos y tiempos
// (nunca teléfonos ni contenido de conversaciones).
// ─────────────────────────────────────────────────────────────────────────────

export type TipoAlerta =
  | "cola_atascada"
  | "dlq_reciente"
  | "tenant_sin_entrantes"
  | "token_whatsapp_invalido"
  | "cuota_agotada";

export type SeveridadAlerta = "critica" | "aviso";

export interface Alerta {
  tipo: TipoAlerta;
  /** null/undefined = alerta global de la plataforma (no de un negocio puntual). */
  tenantId?: string | null;
  severidad: SeveridadAlerta;
  /** Texto corto y legible para un humano. SIN datos personales. */
  mensaje: string;
  /** Datos extra para el log/Sentry (conteos, umbrales). SIN datos personales. */
  datos?: Record<string, unknown>;
  /** Cooldown propio de esta alerta; si no se da, `ALERTAS_COOLDOWN_MIN`. */
  cooldownMs?: number;
}

function cooldownDefaultMs(): number {
  const n = Number(process.env.ALERTAS_COOLDOWN_MIN);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 60_000;
}

const TIMEOUT_WEBHOOK_MS = 5_000;
// Discord corta en 2000 caracteres y Slack trunca mensajes muy largos: con este
// tope el texto entra en ambos sin que el envío falle por tamaño.
const MAX_LARGO_TEXTO = 1_900;

/** Última vez (epoch ms) que salió una alerta por cada clave (tipo, tenant). */
const ultimaAlertaPorClave = new Map<string, number>();

type EnviadorWebhook = (url: string, cuerpo: { text: string; content: string }) => Promise<void>;

async function enviarWebhookReal(url: string, cuerpo: { text: string; content: string }): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: conTimeout(TIMEOUT_WEBHOOK_MS),
  });
  if (!res.ok) throw new Error(`webhook de alertas respondió ${res.status}`);
}

let enviarWebhook: EnviadorWebhook = enviarWebhookReal;

function claveDe(tipo: TipoAlerta, tenantId?: string | null): string {
  return `${tipo}:${tenantId ?? "*"}`;
}

/** Texto plano del mensaje para Slack/Discord. */
function textoWebhook(a: Alerta): string {
  const icono = a.severidad === "critica" ? "🚨" : "⚠️";
  const entorno = process.env.NODE_ENV ?? "development";
  const quien = a.tenantId ? ` · tenant ${a.tenantId}` : "";
  return `${icono} [whatsapp-agent/${entorno}] ${a.tipo}${quien}: ${a.mensaje}`.slice(0, MAX_LARGO_TEXTO);
}

/**
 * Emite una alerta a la plataforma por todos los canales configurados, salvo que
 * la misma (tipo, tenant) ya haya salido dentro de su cooldown. Devuelve `true`
 * si se emitió, `false` si la absorbió la deduplicación.
 *
 * NUNCA lanza ni bloquea: el webhook se manda en segundo plano y su fallo solo se
 * loguea. Se puede llamar desde el hot path (p.ej. `whatsapp/client.ts`).
 */
export function alertarPlataforma(a: Alerta, ahora: number = Date.now()): boolean {
  const clave = claveDe(a.tipo, a.tenantId);
  const cooldown = a.cooldownMs ?? cooldownDefaultMs();
  const ultima = ultimaAlertaPorClave.get(clave);
  if (ultima !== undefined && ahora - ultima < cooldown) return false;
  ultimaAlertaPorClave.set(clave, ahora);

  const campos = { tipo: a.tipo, tenantId: a.tenantId ?? null, severidad: a.severidad, mensaje: a.mensaje, ...a.datos };
  if (a.severidad === "critica") log.error("alerta_plataforma", campos);
  else log.warn("alerta_plataforma", campos);

  capturarError(new Error(`[alerta ${a.tipo}] ${a.mensaje}`), { modulo: "alertas", ...campos });

  const url = process.env.ALERTAS_WEBHOOK_URL;
  if (url) {
    const texto = textoWebhook(a);
    void enviarWebhook(url, { text: texto, content: texto }).catch((e) =>
      log.warn("alerta_webhook_fallo", { tipo: a.tipo, tenantId: a.tenantId ?? null, error: e instanceof Error ? e.message : String(e) }),
    );
  }
  return true;
}

/**
 * Olvida el cooldown de una (tipo, tenant): la próxima ocurrencia vuelve a alertar
 * de inmediato. Se usa cuando el problema se RESUELVE (p.ej. el token volvió a
 * funcionar), para que una recaída no quede silenciada por el cooldown viejo.
 */
export function olvidarAlerta(tipo: TipoAlerta, tenantId?: string | null): void {
  ultimaAlertaPorClave.delete(claveDe(tipo, tenantId));
}

/** ¿Hay algún canal externo (Sentry o webhook) además del log? Para el arranque. */
export function canalesDeAlertaConfigurados(): string[] {
  const canales = ["log"];
  if (process.env.SENTRY_DSN) canales.push("sentry");
  if (process.env.ALERTAS_WEBHOOK_URL) canales.push("webhook");
  return canales;
}

/** Solo para tests: limpia el estado de deduplicación. */
export function _resetAlertasParaTests(): void {
  ultimaAlertaPorClave.clear();
}

/** Solo para tests: reemplaza el POST del webhook (null = vuelve al real). */
export function _configurarEnvioWebhookParaTests(fn: EnviadorWebhook | null): void {
  enviarWebhook = fn ?? enviarWebhookReal;
}
