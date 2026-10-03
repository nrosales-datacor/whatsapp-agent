import { useCallback, useEffect, useRef, useState } from "react";
import { probarPush, suscribirPush } from "../api";

// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones push (Web Push) del panel — portado del inbox.html a un hook.
// El SW (src/sw.ts) lo registramos acá (no por vite-plugin-pwa) para controlar el
// flujo de permisos: solo pedimos permiso cuando el operador toca la campana.
// El SW se sirve en /panel/sw.js (lo genera el build; ver router.ts para servirlo).
// ─────────────────────────────────────────────────────────────────────────────

const soportaPush =
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

// La llave VAPID llega en base64url; el navegador la necesita como Uint8Array.
// Se respalda en un ArrayBuffer explícito para que el tipo sea Uint8Array<ArrayBuffer>
// (lo que pide applicationServerKey: BufferSource), no el Uint8Array<ArrayBufferLike>
// genérico que infiere `new Uint8Array(n)` en TS 5.7+.
function urlB64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export interface EstadoPush {
  /** Mostrar la campana (el navegador soporta push y el server tiene llave VAPID). */
  disponible: boolean;
  /** Hay suscripción y el permiso está concedido. */
  activo: boolean;
  titulo: string;
  /** Activa (o reenvía una prueba de) las notificaciones. */
  activar: () => Promise<void>;
}

export function usePush(vapidPublica: string | null): EstadoPush {
  const [activo, setActivo] = useState(false);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  const disponible = soportaPush && !!vapidPublica;

  const registrarSW = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (!("serviceWorker" in navigator)) return null;
    if (regRef.current) return regRef.current;
    try {
      regRef.current = await navigator.serviceWorker.register("/panel/sw.js");
      return regRef.current;
    } catch (e) {
      console.warn("[panel] SW no registrado:", e);
      return null;
    }
  }, []);

  const subActual = useCallback(async (): Promise<PushSubscription | null> => {
    const reg = regRef.current;
    if (!reg) return null;
    try {
      return await reg.pushManager.getSubscription();
    } catch {
      return null;
    }
  }, []);

  const refrescarEstado = useCallback(async () => {
    if (!disponible) {
      setActivo(false);
      return;
    }
    const sub = await subActual();
    setActivo(!!sub && Notification.permission === "granted");
  }, [disponible, subActual]);

  // Al montar (con push disponible), registramos el SW y pintamos el estado inicial.
  // Si este navegador ya tenía una suscripción con permiso concedido, se la volvemos a
  // mandar al backend (idempotente): desde la revisión de seguridad 2026-10 cada
  // suscripción es del USUARIO logueado y se revoca al cambiar su clave/rol, así que
  // re-registrarla la asocia a quien está usando el panel ahora (y migra las viejas,
  // que no tenían usuario y ya no reciben avisos).
  useEffect(() => {
    if (!disponible) return;
    void registrarSW()
      .then(subActual)
      .then(async (sub) => {
        if (sub && Notification.permission === "granted") await suscribirPush(sub.toJSON()).catch(() => {});
      })
      .then(refrescarEstado);
  }, [disponible, registrarSW, subActual, refrescarEstado]);

  const activar = useCallback(async () => {
    if (!disponible || !vapidPublica) return;
    if (Notification.permission === "denied") {
      alert(
        "Las notificaciones están bloqueadas. Activálas en los ajustes del navegador (ícono junto a la dirección) y volvé a intentar.",
      );
      return;
    }
    try {
      const reg = await registrarSW();
      if (!reg) return;
      await navigator.serviceWorker.ready;
      let sub = await subActual();
      if (!sub) {
        const permiso = await Notification.requestPermission();
        if (permiso !== "granted") {
          await refrescarEstado();
          return;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(vapidPublica),
        });
      }
      // Siempre (también si ya existía): asegura que el backend la tenga a nombre de
      // este usuario antes de mandar la prueba.
      await suscribirPush(sub.toJSON());
      // Reenvía una notificación de prueba (confirma al operador que quedó activo).
      await probarPush().catch(() => {});
      await refrescarEstado();
    } catch (e) {
      console.error("[panel] activarNotif:", e);
      alert("No se pudieron activar las notificaciones: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [disponible, vapidPublica, registrarSW, subActual, refrescarEstado]);

  const titulo = activo
    ? "Notificaciones activas (tocá para enviar una de prueba)"
    : soportaPush && Notification.permission === "denied"
      ? "Notificaciones bloqueadas en el navegador"
      : "Activar notificaciones";

  return { disponible, activo, titulo, activar };
}
