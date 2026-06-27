/// <reference lib="webworker" />
// ─────────────────────────────────────────────────────────────────────────────
// Service worker del panel (PWA + push). Lo compila vite-plugin-pwa (injectManifest)
// a /panel/sw.js → su scope es /panel/. Portado del sw.js anterior: SIN precache
// (passthrough de red → datos siempre frescos); solo agrega instalación + push.
// Tipado con la lib WebWorker en tsconfig.sw.json (no DOM).
// ─────────────────────────────────────────────────────────────────────────────
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  // Activar de una la versión nueva (no esperar a que cierren las pestañas viejas).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handler de red mínimo (passthrough). Tenerlo ayuda a que el navegador ofrezca
// "instalar". No cacheamos datos de la API (siempre frescos).
self.addEventListener("fetch", () => {
  // Sin respondWith → comportamiento de red por defecto.
});

interface DatosPush {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

// ── Notificación push entrante ──
self.addEventListener("push", (event) => {
  let data: DatosPush = {};
  try {
    data = event.data ? (event.data.json() as DatosPush) : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || "Nuevo mensaje";
  // renotify/vibrate no están en el tipo estándar NotificationOptions; los sumamos
  // con un tipo ampliado (igual que el sw.js anterior, para reemplazar el aviso viejo
  // y dar una vibración corta).
  const opciones: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: data.body || "Tenés un mensaje nuevo en la bandeja.",
    icon: "/panel/icons/icon-192.png",
    badge: "/panel/icons/icon-192.png",
    tag: data.tag || "bandeja",
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: data.url || "/panel/" },
  };
  event.waitUntil(self.registration.showNotification(title, opciones));
});

// ── Tocar la notificación: enfocar el panel si ya está abierto, o abrirlo ──
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = (event.notification.data as { url?: string } | null)?.url || "/panel/";
  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of ventanas) {
        if (c.url.includes("/panel") && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(destino);
    })(),
  );
});

export {};
