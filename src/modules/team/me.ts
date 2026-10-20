import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getBusinessContext, type Branding, type Terminology } from "../business";
import { activeMemberships, findUserById } from "./identity";

// ─────────────────────────────────────────────────────────────────────────────
// `me`: lo que el panel necesita para pintarse después del login (quién soy, en qué
// negocio, con qué rol, a qué sucursales entro, en qué otros negocios estoy y qué módulos
// tiene el plan). Lo devuelven /auth/me, el login, el cambio de negocio y aceptar una
// invitación: siempre la misma forma.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Módulos del plan habilitados para un negocio. Lo inyecta la composición (src/routes.ts):
 * los planes viven en `modules/billing` (I2), que el núcleo no puede importar.
 */
export type EnabledModules = (businessId: string) => readonly string[] | Promise<readonly string[]>;

export interface Me {
  user: { id: string; name: string; email: string; mustChangePassword: boolean; totpEnabled: boolean };
  business: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    industry: string;
    currency: string;
    timezone: string;
    terminology: Terminology;
    branding: Branding;
  };
  role: Role;
  /** Sucursales activas a las que entra (todas las del negocio si `allLocations`). */
  locations: Array<{ id: string; name: string }>;
  allLocations: boolean;
  /** Negocios activos en los que tiene membresía activa (para el selector de negocio). */
  memberships: Array<{ businessId: string; businessName: string; role: Role }>;
  modules: string[];
}

export async function buildMe(db: Executor, session: Session, enabledModules: EnabledModules): Promise<Me> {
  const [user, ctx, others, modules] = await Promise.all([
    findUserById(db, session.userId),
    getBusinessContext(db, session.businessId),
    activeMemberships(db, session.userId),
    enabledModules(session.businessId),
  ]);
  // La sesión se validó recién: si falta algo, la cuenta o el negocio se borraron en el medio.
  if (!user || !ctx) throw new HttpError(401, "Tu sesión no es válida o venció. Iniciá sesión de nuevo.", "unauthorized");

  const { business } = ctx;
  const allLocations = session.locationIds === "all";
  const allowed = allLocations ? null : new Set(session.locationIds);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      totpEnabled: user.totpEnabledAt !== null,
    },
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      plan: business.plan,
      industry: business.industry,
      currency: business.currency,
      timezone: business.timezone,
      terminology: { ...ctx.terminology },
      branding: { ...business.branding },
    },
    role: session.role,
    locations: ctx.locations.filter((l) => l.active && (!allowed || allowed.has(l.id))).map((l) => ({ id: l.id, name: l.name })),
    allLocations,
    memberships: others.map((m) => ({ businessId: m.businessId, businessName: m.businessName, role: m.role })),
    modules: [...modules],
  };
}
