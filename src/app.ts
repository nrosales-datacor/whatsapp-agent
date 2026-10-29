import type { Executor } from "./platform/db/scope";
import { serveHealth } from "./platform/http/health";
import { sendJson } from "./platform/http/http";
import { serveLanding } from "./platform/http/landing";
import { serveStaticPanel } from "./platform/http/staticPanel";
import type { HttpHandler } from "./platform/net/http";
import { withSecurityHeaders } from "./platform/net/securityHeaders";

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

export interface AppOptions {
  db: Executor;
  role: ProcessRole;
}

function requestUrl(rawUrl: string | undefined): URL {
  // Base fija (no el header Host): un Host malformado no puede tumbar el request.
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * Handler completo (`ROLE=web` y `ROLE=all`): /health, la API (por ahora 404 JSON: el
 * router declarativo es I0.4), la landing en `/` y el panel estático en `/panel`.
 */
export function createAppHandler({ db, role }: AppOptions): HttpHandler {
  return withSecurityHeaders(async (req, res) => {
    const url = requestUrl(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      await serveHealth(res, url, db, { role });
      return;
    }

    // API del panel (/api/panel/*, la costura estable con el front). Hasta que exista el
    // router declarativo (I0.4) toda ruta de la API responde 404 en JSON, con la misma
    // forma `{ ok, error }` que van a usar las rutas reales.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "Recurso no encontrado." });
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
