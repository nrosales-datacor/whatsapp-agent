import type { IncomingMessage, ServerResponse } from "node:http";
import { obtenerTenantPausadoPorId, obtenerTenantPorId, obtenerUsuarioPorId } from "../config/tenantStore";
import type { Rol, Tenant } from "../types";
import { verificarSesion, verificarSesionAdmin } from "./auth";
import { COOKIE, COOKIE_ADMIN, json, leerCookies } from "./http";

// ─────────────────────────────────────────────────────────────────────────────
// Sesiones del panel: operador (con revocación por epoch) y superadmin, y el aviso de
// negocio pausado.
// ─────────────────────────────────────────────────────────────────────────────

/** Sesión de operador ya resuelta contra el tenantStore (tenant + quién + su rol). */
export interface SesionPanel {
  tenant: Tenant;
  usuarioId: string;
  rol: Rol;
}

/**
 * Devuelve la sesión del operador (tenant, usuarioId, rol), o null si no está autenticado.
 *
 * Revocación de sesiones (E13/ALTO-06): el token es stateless (HMAC + expiración), así
 * que por sí solo NO alcanza para saber si la sesión sigue viva — un dueño puede haber
 * desactivado a este usuario, cambiado su rol o resetéado su clave hace 5 segundos, y el
 * token seguiría teniendo firma válida hasta los 7 días. Por eso, además de `verificarSesion`,
 * se revalida contra la CUENTA VIVA (`obtenerUsuarioPorId`, caché en memoria, no pega la
 * base): si no existe, está inactiva, o su `sessionEpoch` ya no es el que firmó este token,
 * la sesión se trata como inválida — mismo criterio que un token vencido/corrupto (null, sin
 * un código de error nuevo). El `rol` que se devuelve sale de la cuenta viva, nunca del
 * token: así un cambio de rol pega de inmediato, no en el próximo login.
 */
export function sesionDeOperador(req: IncomingMessage): SesionPanel | null {
  const s = verificarSesion(leerCookies(req)[COOKIE]);
  if (!s) return null;
  const tenant = obtenerTenantPorId(s.tenantId);
  if (!tenant) return null;
  const usuario = obtenerUsuarioPorId(s.usuarioId);
  if (!usuario || !usuario.activo) return null;
  if (usuario.sessionEpoch !== s.epoch) return null; // token de una sesión ya revocada
  return { tenant, usuarioId: s.usuarioId, rol: usuario.rol };
}

/** true si el request trae una sesión de superadmin válida (onboarding, ROADMAP B3). */
export function esAdmin(req: IncomingMessage): boolean {
  return verificarSesionAdmin(leerCookies(req)[COOKIE_ADMIN]);
}

// ── Negocio pausado por la plataforma (revisión pre-venta 2026-10, cobro manual) ──
// Un negocio pausado no está en el caché de activos, así que `sesionDeOperador` devuelve
// null y antes el dueño veía un 401/login fallido sin explicación ("¿me hackearon?").
// Ahora, si la sesión (o el login) es VÁLIDA pero el negocio está pausado, se responde
// 403 con un código que el panel reconoce para mostrar "cuenta pausada, contactá a
// Selyon". Solo se revela DESPUÉS de autenticar (firma + cuenta viva + epoch, o clave
// correcta): un anónimo no puede averiguar qué negocios están pausados.
export const CODIGO_CUENTA_PAUSADA = "cuenta_pausada";
export const MENSAJE_CUENTA_PAUSADA = "Tu cuenta está pausada. Contactá a Selyon para reactivarla.";

export function jsonCuentaPausada(res: ServerResponse) {
  json(res, 403, { ok: false, error: MENSAJE_CUENTA_PAUSADA, codigo: CODIGO_CUENTA_PAUSADA });
}

/** true si el request trae una sesión de operador VÁLIDA (mismos chequeos que
 * `sesionDeOperador`) cuyo negocio está pausado. */
export function esSesionDeNegocioPausado(req: IncomingMessage): boolean {
  const s = verificarSesion(leerCookies(req)[COOKIE]);
  if (!s || !obtenerTenantPausadoPorId(s.tenantId)) return false;
  const usuario = obtenerUsuarioPorId(s.usuarioId);
  return !!usuario && usuario.activo && usuario.tenantId === s.tenantId && usuario.sessionEpoch === s.epoch;
}

/** Negocio por id para las acciones del superadmin: activo O pausado (pausar no debe
 * dejar al negocio fuera del alcance del admin que lo tiene que reactivar). */
export function tenantParaAdmin(id: string): Tenant | undefined {
  return obtenerTenantPorId(id) ?? obtenerTenantPausadoPorId(id);
}
