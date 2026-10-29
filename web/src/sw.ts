/// <reference lib="webworker" />
// ─────────────────────────────────────────────────────────────────────────────
// Service worker del panel (PWA + push). Lo compila vite-plugin-pwa (injectManifest) a
// /panel/sw.js → su scope es /panel/. Sin precache (passthrough de red: los datos siempre
// frescos); solo instalación + push. Tipado con la lib WebWorker en tsconfig.sw.json.
//
// Lo registra main.tsx (solo en el build) y la suscripción la maneja lib/push.ts. Portado
// del panel anterior (legacy/web/src/sw.ts).
//
// Payload del push (JSON, todo opcional): { title, body, tag, url, conversationId }. Con
// `conversationId`, tocar la notificación abre esa conversación de la bandeja; si no, `url`
// (solo dentro de /panel/: cualquier otra cosa abre el inicio del panel).
// ─────────────────────────────────────────────────────────────────────────────
declare const self: ServiceWorkerGlobalScope;

const PANEL_SCOPE = "/panel/";

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
  conversationId?: string;
}

/** URL segura dentro del panel: la de la conversación, la que mandó el backend o el inicio. */
function targetUrl(data: PushPayload): string {
  if (typeof data.conversationId === "string" && data.conversationId) {
    return `${PANEL_SCOPE}whatsapp/conversations/${encodeURIComponent(data.conversationId)}`;
  }
  if (typeof data.url === "string") {
    try {
      const url = new URL(data.url, self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith(PANEL_SCOPE)) return url.pathname + url.search;
    } catch {
      // URL inválida: al inicio del panel
    }
  }
  return PANEL_SCOPE;
}

async function panelWindows(): Promise<WindowClient[]> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.filter((client) => new URL(client.url).pathname.startsWith(PANEL_SCOPE.slice(0, -1)));
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
  const tag = data.tag || (data.conversationId ? `conversation-${data.conversationId}` : "panel");
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: data.body || "Tenés una novedad en tu panel.",
    icon: "/panel/icons/icon-192.png",
    badge: "/panel/icons/icon-192.png",
    tag,
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: targetUrl(data) },
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || "Selyon CRM", options);
      // Con el panel abierto, que refresque la bandeja sin esperar al próximo ciclo.
      for (const client of await panelWindows()) client.postMessage({ type: "push" });
    })(),
  );
});

// ── Tocar la notificación: enfocar el panel si ya está abierto (y navegar adentro) o abrirlo ──
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url || PANEL_SCOPE;
  event.waitUntil(
    (async () => {
      const [client] = await panelWindows();
      if (client) {
        // La app navega sin recargar (app/push.tsx); si no puede, el navegador navega.
        try {
          client.postMessage({ type: "open-url", url: target });
        } catch {
          await client.navigate(target).catch(() => undefined);
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});

export {};
