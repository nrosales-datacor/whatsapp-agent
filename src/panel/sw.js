// Service worker del panel: habilita la instalación como app (PWA) y recibe las
// notificaciones push aunque el panel esté cerrado.
// Servido en /panel/sw.js → su alcance (scope) es /panel/.

const VERSION = "bandeja-v1";

self.addEventListener("install", () => {
  // Activar de una la versión nueva (no esperar a que cierren las pestañas viejas).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handler de red mínimo (passthrough). Tenerlo ayuda a que el navegador ofrezca
// "instalar" la app. No cacheamos datos de la API (siempre datos frescos).
self.addEventListener("fetch", () => {
  // Sin respondWith → comportamiento de red por defecto.
});

// ── Notificación push entrante ──
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data && event.data.text() };
  }
  const title = data.title || "Nuevo mensaje";
  const opciones = {
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
  const destino = (event.notification.data && event.notification.data.url) || "/panel/";
  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of ventanas) {
        if (c.url.includes("/panel") && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })(),
  );
});
