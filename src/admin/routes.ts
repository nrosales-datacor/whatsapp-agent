import { z } from "zod";
import { isAdminTotpConfigured } from "../platform/auth/sessionToken";
import { recordAudit, superadminActor } from "../platform/audit/auditLog";
import { withSystem, type Executor } from "../platform/db/scope";
import { created, noContent, route } from "../platform/http/router";
import type { Route } from "../platform/http/routeTypes";
import { getClientIp } from "../platform/net/clientIp";
import {
  adminRowOf,
  changeBusinessPlan,
  getAdminBusinessDetail,
  listAdminBusinesses,
  pauseBusiness,
  PauseInput,
  PlanChangeInput,
  reactivateBusiness,
  type PlanService,
} from "../modules/billing";
import { createBusiness, INDUSTRIES, isValidTimeZone, summarizeBusiness } from "../modules/business";
import { applyCatalogTemplate } from "../modules/catalog";
import { inviteMember } from "../modules/team";
import { adminLogin, clearAdminSessionCookie, setAdminSessionCookie, superadminUsername } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// API del superadmin (/api/panel/admin/*): entrar, salir, ver y crear negocios, y el
// cobro manual (I2). Crear un negocio = el negocio + su primera sucursal con horario
// default + la invitación por correo al dueño, todo en UNA transacción (si el correo no se
// puede encolar, no queda un negocio a medias) y con su rastro en audit_log.
//
//   GET    /admin/businesses                 lista con el plan efectivo
//   POST   /admin/businesses                 alta
//   GET    /admin/businesses/:id             detalle: plan, cupos, uso del mes, auditoría
//   PATCH  /admin/businesses/:id/plan        { plan?, extraModules?, limits?, billingStatus? }
//   POST   /admin/businesses/:id/pause       { reason? } → la API del negocio responde 403
//                                            `business_paused` y la cola posterga su trabajo
//   POST   /admin/businesses/:id/reactivate
//
// Plan, pausa y cobro viven en modules/billing (con su auditoría en la misma transacción).
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminRouteDeps {
  db: Executor;
  /** Planes: uso del mes para el detalle. */
  plans: Pick<PlanService, "usage">;
}

const BusinessParams = z.object({ id: z.uuid() });

const LoginBody = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().max(16).optional(),
});

const Name = z.string().trim().min(1).max(120);

const CreateBusinessBody = z.object({
  name: Name,
  industry: z.enum(INDUSTRIES),
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria inválida (ej. America/Costa_Rica)."),
  currency: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "Moneda inválida (código ISO de 3 letras, ej. CRC).")),
  country: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, "País inválido (código ISO de 2 letras, ej. CR).")),
  locationName: Name,
  ownerEmail: z.email().max(320),
  ownerName: Name,
});

function adminMe() {
  return { username: superadminUsername() ?? "", totpEnabled: isAdminTotpConfigured() };
}

export function adminRoutes({ db, plans }: AdminRouteDeps): Route[] {
  return [
    route({ method: "POST", path: "/admin/login", auth: "public", body: LoginBody }, async ({ req, res, body }) => {
      const result = await adminLogin(db, { ...body, ip: getClientIp(req) });
      if (result.status === "totp_required") return { status: "totp_required" as const };
      setAdminSessionCookie(res, result.withTotp);
      return { status: "ok" as const, me: adminMe() };
    }),

    route({ method: "POST", path: "/admin/logout", auth: "public" }, ({ res }) => {
      clearAdminSessionCookie(res);
      return noContent();
    }),

    route({ method: "GET", path: "/admin/me", auth: "superadmin" }, () => adminMe()),

    route({ method: "GET", path: "/admin/businesses", auth: "superadmin" }, () => listAdminBusinesses(db)),

    route({ method: "POST", path: "/admin/businesses", auth: "superadmin", body: CreateBusinessBody }, async ({ session, body, log }) => {
      const actor = superadminActor(session.adminId);
      const summary = await withSystem(db, async (tx) => {
        // La plantilla del rubro precarga terminología, campos y el catálogo de ejemplo.
        const { business } = await createBusiness(
          tx,
          {
            name: body.name,
            industry: body.industry,
            timezone: body.timezone,
            currency: body.currency,
            country: body.country,
            locationName: body.locationName,
          },
          { seedCatalog: applyCatalogTemplate },
        );
        await inviteMember(tx, {
          business: { id: business.id, name: business.name },
          email: body.ownerEmail,
          name: body.ownerName,
          role: "owner",
          invitedByName: null,
          actor,
        });
        await recordAudit(tx, business.id, "business_created", actor, { industry: business.industry, plan: business.plan });
        return summarizeBusiness(business, 1);
      });
      log.info("business_created", { businessId: summary.id });
      return created(adminRowOf(summary));
    }),

    route({ method: "GET", path: "/admin/businesses/:id", auth: "superadmin", params: BusinessParams }, ({ params }) =>
      getAdminBusinessDetail(db, plans, params.id),
    ),

    route(
      { method: "PATCH", path: "/admin/businesses/:id/plan", auth: "superadmin", params: BusinessParams, body: PlanChangeInput },
      async ({ session, params, body, log }) => {
        await changeBusinessPlan(db, params.id, body, superadminActor(session.adminId));
        log.info("business_plan_changed", { businessId: params.id });
        return getAdminBusinessDetail(db, plans, params.id);
      },
    ),

    route(
      { method: "POST", path: "/admin/businesses/:id/pause", auth: "superadmin", params: BusinessParams, body: PauseInput },
      async ({ session, params, body, log }) => {
        await pauseBusiness(db, params.id, body.reason, superadminActor(session.adminId));
        log.info("business_paused", { businessId: params.id });
        return getAdminBusinessDetail(db, plans, params.id);
      },
    ),

    route(
      { method: "POST", path: "/admin/businesses/:id/reactivate", auth: "superadmin", params: BusinessParams },
      async ({ session, params, log }) => {
        await reactivateBusiness(db, params.id, superadminActor(session.adminId));
        log.info("business_reactivated", { businessId: params.id });
        return getAdminBusinessDetail(db, plans, params.id);
      },
    ),
  ];
}
