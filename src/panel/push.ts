import webpush from "web-push";
import type { Repositorio } from "../types";

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

/**
 * Envía una notificación a TODOS los navegadores suscritos de un negocio.
 * Limpia las suscripciones muertas (404/410) para no reintentar en vano.
 */
export async function enviarPushATenant(
  repo: Repositorio,
  tenantId: string,
  payload: PushPayload,
): Promise<{ enviadas: number; fallidas: number }> {
  if (!configurado) return { enviadas: 0, fallidas: 0 };
  const subs = await repo.listarPushSubs(tenantId);
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
