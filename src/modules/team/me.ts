import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import type { PlanHooks, PlanSnapshot } from "../../platform/plan/planHooks";
import { getBusinessContext, type Branding, type Terminology } from "../business";
import { activeMemberships, findUserById } from "./identity";
import { getLegalStatus, type LegalStatus } from "./legal";
import { getStaffIdForUser } from "./staffDirectory";

// ─────────────────────────────────────────────────────────────────────────────
// `me`: lo que el panel necesita para pintarse después del login (quién soy, en qué
// negocio, con qué rol, a qué sucursales entro, en qué otros negocios estoy, qué trae el
// plan: módulos, nivel de clientes, límites y uso, y si tengo que aceptar los términos y el
// aviso de privacidad vigentes). Lo devuelven /auth/me, el login, el cambio de negocio y
// aceptar una invitación: siempre la misma forma.
//
// El plan lo resuelve `modules/billing`, que el núcleo no puede importar: llega inyectado
// como `PlanHooks.snapshot` (src/platform/plan/planHooks.ts). Si el plan no incluye la
// marca propia, `business.branding` sale vacío (la marca guardada se conserva).
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Módulos habilitados (igual que `plan.modules`; se conserva por compatibilidad). */
  modules: string[];
  /** Plan del negocio: nombre, nivel de clientes, módulos, límites y uso del mes. */
  plan: PlanSnapshot;
  /** Profesional vinculado a esta cuenta en el negocio (su carril en "Mi agenda"), o null. */
  staffId: string | null;
  /** Términos y aviso de privacidad: versión vigente, lo que aceptó y si tiene que aceptar de nuevo. */
  legal: LegalStatus;
}

export async function buildMe(db: Executor, session: Session, plans: Pick<PlanHooks, "snapshot">): Promise<Me> {
  const [user, ctx, others, plan, staffId, legal] = await Promise.all([
    findUserById(db, session.userId),
    getBusinessContext(db, session.businessId),
    activeMemberships(db, session.userId),
    plans.snapshot(session.businessId),
    getStaffIdForUser(db, session.businessId, session.userId),
    getLegalStatus(db, session.businessId, session.userId),
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
      branding: plan.features.includes("branding") ? { ...business.branding } : {},
    },
    role: session.role,
    locations: ctx.locations.filter((l) => l.active && (!allowed || allowed.has(l.id))).map((l) => ({ id: l.id, name: l.name })),
    allLocations,
    memberships: others.map((m) => ({ businessId: m.businessId, businessName: m.businessName, role: m.role })),
    modules: [...plan.modules],
    plan,
    staffId,
    legal,
  };
}
