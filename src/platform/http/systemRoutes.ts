import { route } from "./router";
import type { Route } from "./routeTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de la plataforma misma (no de un módulo de negocio).
// ─────────────────────────────────────────────────────────────────────────────

export function systemRoutes(): Route[] {
  return [
    // Ping público de la API: el front lo usa para saber si el backend responde, sin sesión.
    route({ method: "GET", path: "/ping", auth: "public" }, () => ({ pong: true })),
  ];
}
