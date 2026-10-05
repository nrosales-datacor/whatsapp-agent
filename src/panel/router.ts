import type { IncomingMessage, ServerResponse } from "node:http";
import type { Repositorio } from "../types";
import { json, mismoOrigen } from "./http";
import { esSesionDeNegocioPausado, jsonCuentaPausada, sesionDeOperador } from "./sesion";
import { servirEstaticosPanel } from "./estaticos";
import { manejarRutasAdmin } from "./rutas/admin";
import { manejarRutasAcceso } from "./rutas/acceso";
import { manejarRutasCuenta } from "./rutas/cuenta";
import { manejarRutasUsuarios } from "./rutas/usuarios";
import { manejarRutasCampanias } from "./rutas/campanias";
import { manejarRutasConfig } from "./rutas/config";
import { manejarRutasPush } from "./rutas/push";
import { manejarRutasAgenda } from "./rutas/agenda";
import { manejarRutasBandeja } from "./rutas/bandeja";
import type { ContextoOperador } from "./rutas/contexto";

// API pública que usan otros módulos y los tests.
export { leerCookies } from "./http";
export { CODIGO_CUENTA_PAUSADA, esSesionDeNegocioPausado, sesionDeOperador } from "./sesion";

// ─────────────────────────────────────────────────────────────────────────────
// Panel web. Maneja /panel, /panel/* (estáticos y SPA) y la API JSON /api/panel/*.
// Devuelve true si manejó la request; false si no es ruta del panel.
//
// Orden: estáticos → guard CSRF de todo POST → superadmin (sesión propia) → login/logout
// → guard de sesión del operador → grupos de rutas (src/panel/rutas/*). Las rutas de cada
// grupo son disjuntas; un grupo devuelve false si la ruta no es suya.
// ─────────────────────────────────────────────────────────────────────────────

const RUTAS_OPERADOR: ((ctx: ContextoOperador) => Promise<boolean>)[] = [
  manejarRutasCuenta,
  manejarRutasUsuarios,
  manejarRutasCampanias,
  manejarRutasConfig,
  manejarRutasPush,
  manejarRutasAgenda,
  manejarRutasBandeja,
];

export async function manejarPanel(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repositorio,
  pathname: string,
): Promise<boolean> {
  const metodo = req.method ?? "GET";
  if (servirEstaticosPanel(res, pathname, metodo)) return true;

  if (!pathname.startsWith("/api/panel/")) return false;
  const ruta = pathname.slice("/api/panel/".length).replace(/\/$/, "");

  // CSRF: todo POST del panel cambia estado y debe venir del mismo origen.
  if (metodo === "POST" && !mismoOrigen(req)) {
    json(res, 403, { ok: false, error: "Origen no permitido" });
    return true;
  }

  if (await manejarRutasAdmin(req, res, ruta, metodo)) return true;
  if (await manejarRutasAcceso(req, res, repo, ruta, metodo)) return true;

  // ── A partir de acá, todo requiere sesión de operador ──
  const sesion = sesionDeOperador(req);
  if (!sesion) {
    if (esSesionDeNegocioPausado(req)) return jsonCuentaPausada(res), true;
    json(res, 401, { ok: false, error: "No autenticado" });
    return true;
  }
  const ctx: ContextoOperador = { req, res, repo, ruta, metodo, ...sesion };
  for (const manejar of RUTAS_OPERADOR) {
    if (await manejar(ctx)) return true;
  }

  json(res, 404, { ok: false, error: "Ruta no encontrada" });
  return true;
}
