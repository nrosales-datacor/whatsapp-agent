import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  createSessionToken,
  isRole,
  SESSION_MAX_AGE_SEC,
  verifySessionToken,
  type SessionClaims,
} from "../../platform/auth/sessionToken";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { parseCookies, SESSION_COOKIE, sessionCookie } from "../../platform/http/http";
import { log } from "../../platform/observability/log";
import type { Session, SessionResolver } from "../../platform/http/routeTypes";
import { getBusinessContext } from "../business";
import { membershipLocations, memberships, users } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Sesión del equipo: cookie `panel_session` con un token firmado que lleva usuario,
// negocio y epoch (src/platform/auth/sessionToken.ts), validado CONTRA LA BASE en cada
// request. La firma sola no alcanza: un dueño puede haber desactivado a alguien hace 5
// segundos y el token seguiría firmado y vigente 7 días. Por eso `loadSession` exige:
//
//   • el negocio existe y está activo (caché de getBusinessContext, TTL corto). Si está
//     PAUSADO (cobro manual, ver modules/billing) la sesión no se acepta pero tampoco se
//     trata como vencida: 403 `business_paused`, y el panel muestra "Cuenta pausada". Dado
//     de baja (`closed`) = sin sesión (401);
//   • el usuario existe y está activo, y su epoch es el del token (cambio de clave, de rol
//     o de estado lo suben → toda sesión vieja muere);
//   • la membresía en ESE negocio existe y está activa.
//
// El rol y las sucursales salen de la membresía viva, nunca del token: un cambio pega en
// la request siguiente. Sucursales: "all" para el dueño o si la membresía no tiene filas
// en `membership_locations`; si no, la lista.
//
// Cookie: HttpOnly, SameSite=Lax (los links de los correos abren el panel con la sesión),
// Secure en producción, 7 días.
// ─────────────────────────────────────────────────────────────────────────────

/** Claims del token de la cookie, sin validar contra la base (null si no hay o no es válido). */
export function readSessionClaims(req: IncomingMessage): SessionClaims | null {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

/** 403 de un negocio pausado (lo usan la sesión y el login). */
export const businessPaused = () =>
  new HttpError(403, "La cuenta de este negocio está pausada. Escribinos para reactivarla.", "business_paused");

/**
 * Valida los claims contra la base y arma la sesión, o null si ya no vale. Lanza 403
 * `business_paused` si el negocio está pausado.
 */
export async function loadSession(db: Executor, claims: SessionClaims): Promise<Session | null> {
  const ctx = await getBusinessContext(db, claims.businessId);
  if (!ctx || (ctx.business.status !== "active" && ctx.business.status !== "paused")) return null;

  const session = await withTenant(db, claims.businessId, async (tx): Promise<Session | null> => {
    // `users` solo es visible desde un negocio si la persona tiene membresía en él
    // (política member_or_system): el join ya filtra a los de afuera.
    const [row] = await tx
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        membershipActive: memberships.active,
        userActive: users.active,
        sessionEpoch: users.sessionEpoch,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.businessId, claims.businessId), eq(memberships.userId, claims.userId)))
      .limit(1);
    if (!row || !row.userActive || !row.membershipActive) return null;
    if (row.sessionEpoch !== claims.sessionEpoch) return null; // sesión revocada
    if (!isRole(row.role)) return null;

    let locationIds: Session["locationIds"] = "all";
    if (row.role !== "owner") {
      const rows = await tx
        .select({ locationId: membershipLocations.locationId })
        .from(membershipLocations)
        .where(eq(membershipLocations.membershipId, row.membershipId));
      if (rows.length > 0) locationIds = rows.map((r) => r.locationId);
    }
    return {
      userId: claims.userId,
      businessId: claims.businessId,
      role: row.role,
      locationIds,
      sessionEpoch: row.sessionEpoch,
    };
  });
  // Recién con la sesión validada: alguien que ya no es miembro ve un 401, no el estado del negocio.
  if (session && ctx.business.status === "paused") throw businessPaused();
  return session;
}

/**
 * Aviso de cada request con una sesión válida (la composición lo usa para contar
 * "usuarios activos" del día). Un error del gancho se registra y no corta el request.
 */
export type SessionSeenHook = (executor: Executor, session: Session) => Promise<void> | void;

/** El `SessionResolver` del router: cookie → claims → sesión validada contra la base. */
export function createSessionResolver(db: Executor, options: { onSession?: SessionSeenHook } = {}): SessionResolver {
  return async (req) => {
    const claims = readSessionClaims(req);
    const session = claims ? await loadSession(db, claims) : null;
    if (session && options.onSession) {
      try {
        await options.onSession(db, session);
      } catch (error) {
        log.warn("session_seen_hook_failed", { businessId: session.businessId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return session;
  };
}

/** Fija la cookie de sesión (login, cambio de negocio, re-emisión tras subir el epoch). */
export function setSessionCookie(res: ServerResponse, claims: SessionClaims): void {
  res.setHeader("set-cookie", sessionCookie(SESSION_COOKIE, createSessionToken(claims), { maxAgeSec: SESSION_MAX_AGE_SEC, sameSite: "Lax" }));
}

/** Borra la cookie de sesión (logout). */
export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", sessionCookie(SESSION_COOKIE, "", { maxAgeSec: 0, sameSite: "Lax" }));
}
