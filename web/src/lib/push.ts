import { api, ApiError, isApiError } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones push (Web Push) del panel, sin React. Portado de legacy/web/src/hooks/
// usePush.ts y lib/pushLocal.ts:
//
//   • El service worker (src/sw.ts → /panel/sw.js, scope /panel/) lo registra main.tsx en
//     el build; en desarrollo Vite no lo sirve y todo esto queda en "no disponible".
//   • El permiso se pide SOLO cuando la persona toca "Activar notificaciones".
//   • Cada suscripción es del USUARIO logueado: al entrar se le vuelve a mandar al backend
//     (idempotente) y al salir se da de baja en el backend y en el navegador, así el
//     próximo que entre en el mismo dispositivo no hereda los avisos.
//   • Todo con try/catch: un navegador sin soporte (o con el permiso bloqueado) nunca
//     rompe el panel.
// ─────────────────────────────────────────────────────────────────────────────

const SW_URL = "/panel/sw.js";
const SW_SCOPE = "/panel/";
const READY_TIMEOUT_MS = 10_000;
const LOGOUT_TIMEOUT_MS = 2_000;

export type PushState = "unsupported" | "denied" | "off" | "on";

/** El navegador soporta Web Push (y la página es un contexto seguro). */
export function pushSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  } catch {
    return false;
  }
}

/** Registra el service worker del panel. null si el navegador no puede (o no está servido). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!("serviceWorker" in navigator)) return null;
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch (error) {
    console.warn("[panel] No se pudo registrar el service worker:", error);
    return null;
  }
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!("serviceWorker" in navigator)) return null;
    return (await navigator.serviceWorker.getRegistration(SW_SCOPE)) ?? null;
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await existingRegistration();
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Estado de las notificaciones en ESTE navegador. */
export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  try {
    if (Notification.permission === "denied") return "denied";
    const subscription = await currentSubscription();
    return subscription && Notification.permission === "granted" ? "on" : "off";
  } catch {
    return "off";
  }
}

// La llave VAPID llega en base64url; el navegador la necesita como bytes (respaldados en
// un ArrayBuffer explícito: es el BufferSource que pide applicationServerKey).
function base64UrlToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function subscriptionBody(subscription: PushSubscription): { endpoint: string; keys: Record<string, string> } {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint ?? subscription.endpoint, keys: json.keys ?? {} };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms))]);
}

/** Error de push con un mensaje apto para mostrar. */
export class PushError extends Error {}

/**
 * Activa las notificaciones: registra el service worker si hace falta, pide el permiso,
 * suscribe el navegador con la llave del servidor, la guarda a nombre de este usuario y
 * manda una notificación de prueba. Lanza PushError con el motivo si algo falla.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new PushError("Este navegador no permite notificaciones. Probá con Chrome, Edge, Firefox o Safari actualizados.");
  if (Notification.permission === "denied") {
    throw new PushError("Las notificaciones están bloqueadas. Habilitalas en los ajustes del navegador (el ícono junto a la dirección) y probá de nuevo.");
  }
  const registration = (await existingRegistration()) ?? (await registerServiceWorker());
  if (!registration) throw new PushError("No pudimos preparar las notificaciones en este navegador. Probá de nuevo más tarde.");
  const ready = await withTimeout(navigator.serviceWorker.ready, READY_TIMEOUT_MS);
  if (!ready) throw new PushError("No pudimos preparar las notificaciones en este navegador. Recargá la página y probá de nuevo.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushError("Sin permiso no podemos avisarte. Cuando quieras, tocá de nuevo «Activar notificaciones».");

  try {
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { key } = await api.get<{ key: string }>("/push/public-key");
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
    }
    // Siempre (también si ya existía): la deja a nombre de quien usa el panel ahora.
    await api.post<void>("/push/subscribe", subscriptionBody(subscription));
  } catch (error) {
    if (isApiError(error)) throw new PushError(error.message);
    throw new PushError("No pudimos activar las notificaciones en este navegador. Probá de nuevo más tarde.");
  }
  await api.post<unknown>("/push/test").catch(() => undefined);
}

/** Desactiva las notificaciones de ESTE navegador (en el backend y en el navegador). */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  try {
    await api.post<void>("/push/unsubscribe", { endpoint: subscription.endpoint });
  } catch (error) {
    if (error instanceof ApiError && error.status !== 404) throw new PushError(error.message);
  }
  await subscription.unsubscribe().catch(() => false);
}

/** Al entrar: si este navegador ya tenía suscripción con permiso, se la asocia al usuario actual. */
export async function resyncPush(): Promise<void> {
  try {
    const subscription = await currentSubscription();
    if (subscription && Notification.permission === "granted") await api.post<void>("/push/subscribe", subscriptionBody(subscription));
  } catch {
    // best-effort: el estado se vuelve a leer en el próximo ingreso
  }
}

/** Al salir: da de baja la suscripción de este dispositivo (con tope de tiempo: el logout sigue igual). */
export async function forgetPushOnLogout(): Promise<void> {
  if (!pushSupported()) return;
  await withTimeout(
    (async () => {
      try {
        await disablePush();
      } catch {
        // best-effort
      }
    })(),
    LOGOUT_TIMEOUT_MS,
  );
}
