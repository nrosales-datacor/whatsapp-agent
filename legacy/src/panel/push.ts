import webpush from "web-push";
import type { PushSub, Repositorio } from "../types";
import { obtenerUsuarioPorId } from "../config/tenantStore";

// ─────────────────────────────────────────────────────────────────────────────
// Web Push (notificaciones al navegador/celular del operador).
// Usa la librería `web-push` para el cifrado (RFC 8291) y VAPID (RFC 8292).
// Las llaves VAPID se generan UNA vez con `npx web-push generate-vapid-keys`
// y se guardan en .env (la privada NUNCA se expone al cliente).
// ─────────────────────────────────────────────────────────────────────────────

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
// "sub" del VAPID: debe ser un mailto: o una URL del servicio. Identifica al emisor.
const SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:soporte@selyon.app";

let configurado = false;
if (PUB && PRIV) {
  webpush.setVapidDetails(SUBJECT, PUB, PRIV);
  configurado = true;
}

export function pushConfigurado(): boolean {
  return configurado;
}

/** Llave pública VAPID que el navegador necesita para suscribirse. */
export function clavePublicaVapid(): string | null {
  return configurado ? PUB! : null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Adónde llevar al operador al tocar la notificación. */
  url?: string;
  /** Agrupa notificaciones del mismo chat (evita acumular muchas). */
  tag?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de la suscripción (revisión de seguridad pre-venta 2026-10).
//
// El `endpoint` de una suscripción es una URL a la que ESTE servidor le hace un POST
// (web-push) cada vez que notifica. Antes se aceptaba cualquier string: un operador
// logueado podía registrar `http://169.254.169.254/...` o un host interno y disparar
// POSTs a voluntad con "Probar notificaciones" (SSRF ciego). Ahora el endpoint tiene que
// ser https y apuntar a uno de los servicios de push reales de los navegadores:
//   • Chrome/Edge (Android, escritorio) → fcm.googleapis.com
//   • Safari / iOS (web push)           → *.push.apple.com
//   • Firefox                           → updates.push.services.mozilla.com
//   • Edge heredado / Windows (WNS)     → *.notify.windows.com (incluye wns2-*.notify.windows.com)
// Si mañana aparece otro navegador con otro servicio, se agrega acá (un host que no está
// en la lista simplemente no puede activar notificaciones: falla cerrado).
// ─────────────────────────────────────────────────────────────────────────────

const HOSTS_PUSH_EXACTOS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const SUFIJOS_PUSH = [".push.apple.com", ".notify.windows.com"];

const MAX_LARGO_ENDPOINT = 1024;
// p256dh: llave pública EC P-256 sin comprimir (65 bytes → 87 chars base64url).
// auth: secreto de 16 bytes (22 chars base64url). Se deja algo de holgura por padding.
const RE_P256DH = /^[A-Za-z0-9_-]{80,100}={0,2}$/;
const RE_AUTH = /^[A-Za-z0-9_-]{16,32}={0,2}$/;

/** Tope de dispositivos suscritos por usuario (se conservan los más recientes). */
export const MAX_PUSH_SUBS_POR_USUARIO = Math.max(1, Number(process.env.PANEL_PUSH_MAX_POR_USUARIO ?? 5) || 5);

/** true si `endpoint` es una URL https de un servicio de push conocido (sin credenciales ni puerto raro). */
export function endpointPushPermitido(endpoint: string): boolean {
  if (endpoint.length > MAX_LARGO_ENDPOINT) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (HOSTS_PUSH_EXACTOS.has(host)) return true;
  return SUFIJOS_PUSH.some((suf) => host.endsWith(suf) && host.length > suf.length);
}

/**
 * Valida el cuerpo de `push/suscribir` (lo que manda `PushSubscription.toJSON()`).
 * Devuelve la suscripción normalizada, o un mensaje de error para el 400.
 */
export function validarSuscripcionPush(
  body: unknown,
): { ok: true; sub: Pick<PushSub, "endpoint" | "p256dh" | "auth"> } | { ok: false; error: string } {
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
  const p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh : "";
  const auth = typeof b.keys?.auth === "string" ? b.keys.auth : "";
  if (!endpoint || !p256dh || !auth) return { ok: false, error: "Suscripción inválida" };
  if (!endpointPushPermitido(endpoint)) return { ok: false, error: "Servicio de notificaciones no permitido" };
  if (!RE_P256DH.test(p256dh) || !RE_AUTH.test(auth)) return { ok: false, error: "Suscripción inválida" };
  return { ok: true, sub: { endpoint, p256dh, auth } };
}

/**
 * ¿Esta suscripción sigue viva? Solo si es de un usuario que (a) existe y está activo en
 * el caché del tenantStore, (b) es de ESTE negocio y (c) no cambió su sessionEpoch desde
 * que se suscribió — mismo criterio que `sesionDeOperador` para las sesiones (E13/ALTO-06).
 * Las suscripciones viejas sin usuario (de antes de esta revisión) no pasan: expiran.
 */
function suscripcionVigente(tenantId: string, s: PushSub): boolean {
  if (!s.usuarioId || s.sessionEpoch == null) return false;
  if (!endpointPushPermitido(s.endpoint)) return false; // defensa en profundidad (filas viejas)
  const u = obtenerUsuarioPorId(s.usuarioId);
  return !!u && u.activo && u.tenantId === tenantId && u.sessionEpoch === s.sessionEpoch;
}

/**
 * Envía una notificación a los navegadores suscritos de un negocio (o solo a los de un
 * usuario, con `soloUsuarioId` — p. ej. "Probar notificaciones" le llega solo a quien la
 * pidió). Solo a suscripciones VIGENTES (ver `suscripcionVigente`): las de usuarios
 * desactivados, con la clave/rol cambiados o sin usuario se borran en vez de notificarse.
 * Limpia también las suscripciones muertas (404/410) para no reintentar en vano.
 */
export async function enviarPushATenant(
  repo: Repositorio,
  tenantId: string,
  payload: PushPayload,
  opciones: { soloUsuarioId?: string } = {},
): Promise<{ enviadas: number; fallidas: number }> {
  if (!configurado) return { enviadas: 0, fallidas: 0 };
  const todas = await repo.listarPushSubs(tenantId);
  const subs: PushSub[] = [];
  for (const s of todas) {
    if (suscripcionVigente(tenantId, s)) {
      if (!opciones.soloUsuarioId || s.usuarioId === opciones.soloUsuarioId) subs.push(s);
    } else {
      // Revocada o huérfana: no se le manda nada y se borra (purga perezosa).
      await repo.borrarPushSub(tenantId, s.endpoint).catch(() => {});
    }
  }
  let enviadas = 0;
  let fallidas = 0;
  const cuerpo = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          cuerpo,
          { TTL: 3600 },
        );
        enviadas++;
      } catch (e: any) {
        fallidas++;
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          // Suscripción caducada o cancelada → la borramos.
          await repo.borrarPushSub(tenantId, s.endpoint).catch(() => {});
        } else {
          console.error("[push] error al enviar:", code ?? e?.message ?? e);
        }
      }
    }),
  );

  return { enviadas, fallidas };
}
