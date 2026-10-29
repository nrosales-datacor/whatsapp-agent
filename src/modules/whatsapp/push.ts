import { and, asc, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { withSystem, withTenant, type Executor } from "../../platform/db/scope";
import { pushSubscriptions } from "../../platform/db/schema";
import type { Session } from "../../platform/http/routeTypes";
import { log } from "../../platform/observability/log";
import { activeMemberSessionEpochs } from "../team";

// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones Web Push al equipo (PWA del panel), portado de legacy/src/panel/push.ts.
// Avisan que una conversación necesita a una persona.
//
//   • Suscripción por usuario Y negocio, con el `session_epoch` con el que se registró:
//     si la persona se desactiva o su epoch sube (clave, rol, estado), su suscripción deja
//     de recibir y se borra en el próximo envío (las notificaciones traen fragmentos de
//     mensajes de clientes).
//   • El `endpoint` es una URL a la que ESTE servidor le hace POST: solo se aceptan https
//     de los servicios de push reales de los navegadores (si no, un usuario podía apuntarlo
//     a un host interno: SSRF). Lo que no está en la lista falla cerrado.
//   • Sin llaves VAPID (env) es un no-op: la bandeja sigue funcionando sin push.
// ─────────────────────────────────────────────────────────────────────────────

const EXACT_PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
const MAX_ENDPOINT_LENGTH = 1024;
/** p256dh: llave EC P-256 sin comprimir (87 caracteres base64url); auth: 16 bytes (22). */
export const P256DH_PATTERN = /^[A-Za-z0-9_-]{80,100}={0,2}$/;
export const AUTH_PATTERN = /^[A-Za-z0-9_-]{16,32}={0,2}$/;
/** Dispositivos por persona (se conservan los más recientes). */
const MAX_SUBSCRIPTIONS_PER_USER = 5;

/** true si `endpoint` es https de un servicio de push conocido (sin credenciales ni puerto raro). */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  return EXACT_PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Adónde lleva tocar la notificación. */
  url?: string;
  /** Agrupa las del mismo chat (no se acumulan). */
  tag?: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Envía un push. Lanza con `statusCode` (404/410 = la suscripción ya no existe). */
export type PushTransport = (target: PushTarget, payload: string) => Promise<void>;

/** Llave pública VAPID para el navegador, o null si push no está configurado. */
export function vapidPublicKey(): string | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  return pub && process.env.VAPID_PRIVATE_KEY?.trim() ? pub : null;
}

let configuredVapid: string | null = null;

/** Transporte real (`web-push`, cifrado RFC 8291 + VAPID). null sin llaves configuradas. */
export function webPushTransport(): PushTransport | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:soporte@selyon.app";
  const key = `${subject}|${pub}|${priv}`;
  if (configuredVapid !== key) {
    webpush.setVapidDetails(subject, pub, priv);
    configuredVapid = key;
  }
  return async (target, payload) => {
    // Con tope: un servicio de push lento no frena el turno que avisa.
    await webpush.sendNotification(target, payload, { TTL: 3600, timeout: 10_000 });
  };
}

// ── Suscripciones ────────────────────────────────────────────────────────────

/** Guarda (o renueva) la suscripción de este dispositivo para la persona de la sesión. */
export async function savePushSubscription(
  db: Executor,
  session: Session,
  subscription: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  // El endpoint es único en la plataforma: si este navegador estaba suscrito con otra
  // persona o negocio (otra sesión en el mismo dispositivo), esa suscripción se descarta y
  // queda la de la sesión actual. Contexto de sistema solo para ese borrado puntual: el
  // endpoint es un secreto del navegador que hace el request.
  await withSystem(db, (tx) => tx.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, subscription.endpoint)));
  await withTenant(db, session.businessId, async (tx) => {
    await tx.insert(pushSubscriptions).values({
      businessId: session.businessId,
      userId: session.userId,
      sessionEpoch: session.sessionEpoch,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    });
    const mine = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.businessId, session.businessId), eq(pushSubscriptions.userId, session.userId)))
      .orderBy(asc(pushSubscriptions.createdAt));
    const extra = mine.slice(0, Math.max(0, mine.length - MAX_SUBSCRIPTIONS_PER_USER)).map((s) => s.id);
    if (extra.length > 0) await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, extra));
  });
}

/** Borra la suscripción de este dispositivo (solo si es de la persona de la sesión). */
export async function removePushSubscription(db: Executor, session: Session, endpoint: string): Promise<boolean> {
  const rows = await withTenant(db, session.businessId, (tx) =>
    tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.businessId, session.businessId),
          eq(pushSubscriptions.userId, session.userId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      )
      .returning({ id: pushSubscriptions.id }),
  );
  return rows.length > 0;
}

// ── Envío ────────────────────────────────────────────────────────────────────

/**
 * Manda la notificación a los dispositivos vigentes del negocio (o solo a los de
 * `onlyUserId`). Borra las suscripciones revocadas (persona inactiva o epoch distinto) y
 * las muertas (404/410). Nunca lanza.
 */
export async function sendPushToBusiness(
  db: Executor,
  businessId: string,
  payload: PushPayload,
  options: { transport: PushTransport | null; onlyUserId?: string },
): Promise<{ sent: number; failed: number }> {
  const { transport } = options;
  if (!transport) return { sent: 0, failed: 0 };
  try {
    const all = await withTenant(db, businessId, (tx) =>
      tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.businessId, businessId)),
    );
    const epochs = await activeMemberSessionEpochs(db, businessId, all.map((s) => s.userId));
    const stale: string[] = [];
    const targets = all.filter((s) => {
      const valid = epochs.get(s.userId) === s.sessionEpoch && isAllowedPushEndpoint(s.endpoint);
      if (!valid) stale.push(s.id);
      return valid && (!options.onlyUserId || s.userId === options.onlyUserId);
    });
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    await Promise.all(
      targets.map(async (s) => {
        try {
          await transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
          sent++;
        } catch (e) {
          failed++;
          const status = (e as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) stale.push(s.id);
          else log.warn("whatsapp_push_failed", { businessId, status: status ?? null });
        }
      }),
    );
    if (stale.length > 0) {
      await withTenant(db, businessId, (tx) => tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale)));
    }
    return { sent, failed };
  } catch (e) {
    log.error("whatsapp_push_error", { businessId, error: e instanceof Error ? e.message : String(e) });
    return { sent: 0, failed: 0 };
  }
}
