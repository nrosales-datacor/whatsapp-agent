import { resolveSuperadmin } from "./admin/session";
import type { PlanService } from "./modules/billing";
import { createSessionResolver } from "./modules/team";
import { createWhatsAppWebhookHandler, WHATSAPP_WEBHOOK_PATH, type WhatsAppDeps } from "./modules/whatsapp";
import type { Executor } from "./platform/db/scope";
import { serveHealth } from "./platform/http/health";
import { sendJson } from "./platform/http/http";
import { serveLanding } from "./platform/http/landing";
import { createRouter, PANEL_API_PREFIX, type RouterOptions } from "./platform/http/router";
import { serveStaticPanel } from "./platform/http/staticPanel";
import type { HttpHandler } from "./platform/net/http";
import { withSecurityHeaders } from "./platform/net/securityHeaders";
import { createPlans } from "./plans";
import { panelRoutes } from "./routes";

// ─────────────────────────────────────────────────────────────────────────────
// Composición del handler HTTP: qué sirve cada tipo de proceso. Separado de server.ts
// (que arranca el proceso, con efectos de lado) para poder probar las rutas reales en un
// test levantando un `http.createServer(handler)` efímero.
//
// Todas las respuestas salen con las cabeceras de seguridad (CSP, HSTS, nosniff…, ver
// src/platform/net/securityHeaders.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Rol del proceso (env `ROLE`): web (HTTP), worker (colas y schedulers) o all (las dos cosas). */
export type ProcessRole = "web" | "worker" | "all";

/**
 * Lo inyectable del router de la API: sesión del equipo, del superadmin y módulos del
 * plan. Lo que no se pase usa la implementación real (`defaultPanelApiAccess`); un test
 * puede reemplazar una pieza (p. ej. un `moduleGate` que niega) sin tocar las demás.
 */
export type PanelApiAccess = Pick<RouterOptions, "resolveSession" | "resolveSuperadmin" | "moduleGate">;

/**
 * Acceso real: la sesión del equipo validada contra la base (src/modules/team/session.ts),
 * la del superadmin por cookie firmada (src/admin/session.ts) y los módulos del plan
 * (src/modules/billing, compuesto en src/plans.ts).
 */
export function defaultPanelApiAccess(db: Executor, plans: PlanService = createPlans(db)): Required<PanelApiAccess> {
  return { resolveSession: createSessionResolver(db), resolveSuperadmin, moduleGate: plans.moduleGate };
}

export interface AppOptions {
  db: Executor;
  role: ProcessRole;
  panelApi?: PanelApiAccess;
  /** Dependencias del módulo WhatsApp (los tests inyectan dobles de Graph). Default: las reales. */
  whatsapp?: WhatsAppDeps;
  /**
   * Planes (módulos, cupos, marca, `me.plan`). Default: el servicio real de billing con el
   * uso del agente de WhatsApp (src/plans.ts).
   */
  plans?: PlanService;
}

function requestUrl(rawUrl: string | undefined): URL {
  // Base fija (no el header Host): un Host malformado no puede tumbar el request.
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * Handler completo (`ROLE=web` y `ROLE=all`): /health, el webhook de WhatsApp, la API del
 * panel (router declarativo, rutas en src/routes.ts), la landing en `/` y el panel
 * estático en `/panel`.
 */
export function createAppHandler({ db, role, panelApi = {}, whatsapp, plans = createPlans(db) }: AppOptions): HttpHandler {
  // Se arma una vez por proceso: una declaración de rutas incoherente rompe el arranque.
  const panelApiHandler = createRouter({
    routes: panelRoutes({ db, plans, whatsapp }),
    ...defaultPanelApiAccess(db, plans),
    ...panelApi,
  });
  // Webhook de WhatsApp: lo llama Meta (firma propia; sin sesión ni CSRF del panel).
  const whatsappWebhook = createWhatsAppWebhookHandler({ db });

  return withSecurityHeaders(async (req, res) => {
    const url = requestUrl(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      await serveHealth(res, url, db, { role });
      return;
    }

    // Webhook de WhatsApp (Meta): verificación GET y mensajes POST firmados.
    if (pathname === WHATSAPP_WEBHOOK_PATH) {
      await whatsappWebhook(req, res);
      return;
    }

    // API del panel (/api/panel/*, la costura estable con el front): router declarativo
    // con sesión, CSRF, permisos y validación (src/platform/http/router.ts).
    if (pathname === PANEL_API_PREFIX || pathname.startsWith(`${PANEL_API_PREFIX}/`)) {
      await panelApiHandler(req, res);
      return;
    }

    // Cualquier otra ruta bajo /api: 404 en JSON, con la misma forma que la API.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "Recurso no encontrado.", code: "not_found" });
      return;
    }

    // Landing pública: `/`, `/privacidad`, `/terminos`, `/contrato`, `/landing/*`, robots, favicon.
    if (serveLanding(req, res, pathname)) return;

    // Panel web (build de React): /panel y sus assets.
    if (serveStaticPanel(res, pathname, req.method ?? "GET")) return;

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
}

/**
 * Handler mínimo de `ROLE=worker`: SOLO `/health` (health check del propio proceso, para
 * el monitor o el orquestador). Esta réplica no acepta tráfico de negocio.
 */
export function createWorkerHandler({ db, role }: AppOptions): HttpHandler {
  return withSecurityHeaders(async (req, res) => {
    const url = requestUrl(req.url);
    if (url.pathname === "/health") {
      await serveHealth(res, url, db, { role });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
}
