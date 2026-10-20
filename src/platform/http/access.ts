import type { Role } from "../auth/sessionToken";
import { HttpError, ValidationError } from "./errors";
import type { Session } from "./routeTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Reglas de acceso de la configuración del negocio que van más allá de lo que declara la
// ruta (rol) y del header de sucursal (router):
//
//   • Editan dueño y administración (`MANAGER_ROLES`); recepción y profesionales solo leen.
//   • Una sesión limitada a ciertas sucursales (membership_locations) solo toca lo de
//     esas sucursales; lo que abarca al negocio entero (crear una sucursal, un feriado de
//     todo el negocio) pide acceso a todas.
//   • Reordenar: la lista nueva tiene que ser exactamente la actual, en otro orden.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles que editan la configuración del negocio. */
export const MANAGER_ROLES: readonly Role[] = ["owner", "admin"];

/** ¿El rol edita la configuración? */
export function canManage(role: Role): boolean {
  return MANAGER_ROLES.includes(role);
}

const locationForbidden = () => new HttpError(403, "No tenés acceso a esta sucursal.", "location_forbidden");

/** ¿La sesión entra a esta sucursal? */
export function hasLocationAccess(session: Pick<Session, "locationIds">, locationId: string): boolean {
  const { locationIds } = session;
  return locationIds === "all" || locationIds.some((id) => id.toLowerCase() === locationId.toLowerCase());
}

/** 403 `location_forbidden` si la sesión no entra a la sucursal. */
export function assertLocationAccess(session: Pick<Session, "locationIds">, locationId: string): void {
  if (!hasLocationAccess(session, locationId)) throw locationForbidden();
}

/** 403 `location_forbidden` si la sesión está limitada a algunas sucursales. */
export function assertAllLocationsAccess(session: Pick<Session, "locationIds">): void {
  if (session.locationIds !== "all") throw locationForbidden();
}

/**
 * Valida un reordenamiento: `requested` tiene que traer exactamente los ids de `current`
 * (sin repetir, sin faltar, sin sobrar). Si no, 400 con el error en `field`.
 */
export function assertSameIds(current: readonly string[], requested: readonly string[], field = "body.ids"): void {
  const wanted = new Set(requested.map((id) => id.toLowerCase()));
  const sameSize = wanted.size === requested.length && wanted.size === current.length;
  if (!sameSize || !current.every((id) => wanted.has(id.toLowerCase()))) {
    throw new ValidationError({ [field]: "La lista tiene que traer todos los elementos actuales, una vez cada uno." });
  }
}
