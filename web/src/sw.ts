/// <reference lib="webworker" />
// ─────────────────────────────────────────────────────────────────────────────
// Service worker del panel (PWA + push). Lo compila vite-plugin-pwa (injectManifest) a
// /panel/sw.js → su scope es /panel/. Sin precache (passthrough de red: los datos siempre
// frescos); solo instalación + push. Tipado con la lib WebWorker en tsconfig.sw.json.
//
// Portado del panel anterior (legacy/web/src/sw.ts). Todavía nadie lo registra: el
// registro y la suscripción a push vuelven con la bandeja de WhatsApp IA (I2).
// ─────────────────────────────────────────────────────────────────────────────
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  // Activar de una la versión nueva (sin esperar a que cierren las pestañas viejas).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handler de red mínimo (passthrough): tenerlo ayuda a que el navegador ofrezca "instalar".
self.addEventListener("fetch", () => {
  // Sin respondWith → comportamiento de red por defecto.
});

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

// ── Notificación push entrante ──
self.addEventListener("push", (event) => {
  let data: PushPayload = {};
  try {
    data = event.data ? (event.data.json() as PushPayload) : {};
  } catch {
    data = { body: event.data?.text() };
  }
  // renotify/vibrate no están en el tipo estándar de NotificationOptions.
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: data.body || "Tenés una novedad en tu panel.",
    icon: "/panel/icons/icon-192.png",
    badge: "/panel/icons/icon-192.png",
    tag: data.tag || "panel",
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: data.url || "/panel/" },
  };
  event.waitUntil(self.registration.showNotification(data.title || "Selyon CRM", options));
});

// ── Tocar la notificación: enfocar el panel si ya está abierto, o abrirlo en la URL ──
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url || "/panel/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.includes("/panel") && "focus" in client) {
          if ("navigate" in client) await client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

export {};
