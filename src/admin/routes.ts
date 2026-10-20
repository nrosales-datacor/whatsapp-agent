import { z } from "zod";
import { isAdminTotpConfigured } from "../platform/auth/sessionToken";
import { recordAudit, superadminActor } from "../platform/audit/auditLog";
import { withSystem, type Executor } from "../platform/db/scope";
import { created, noContent, route } from "../platform/http/router";
import type { Route } from "../platform/http/routeTypes";
import { getClientIp } from "../platform/net/clientIp";
import { createBusiness, INDUSTRIES, isValidTimeZone, listBusinesses, summarizeBusiness } from "../modules/business";
import { inviteMember } from "../modules/team";
import { adminLogin, clearAdminSessionCookie, setAdminSessionCookie, superadminUsername } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// API del superadmin (/api/panel/admin/*), mínima para I0.6: entrar, salir, ver y crear
// negocios. Crear un negocio = el negocio + su primera sucursal con horario default + la
// invitación por correo al dueño, todo en UNA transacción (si el correo no se puede
// encolar, no queda un negocio a medias) y con su rastro en audit_log.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminRouteDeps {
  db: Executor;
}

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

export function adminRoutes({ db }: AdminRouteDeps): Route[] {
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

    route({ method: "GET", path: "/admin/businesses", auth: "superadmin" }, () => listBusinesses(db)),

    route({ method: "POST", path: "/admin/businesses", auth: "superadmin", body: CreateBusinessBody }, async ({ session, body, log }) => {
      const actor = superadminActor(session.adminId);
      const summary = await withSystem(db, async (tx) => {
        const { business } = await createBusiness(tx, {
          name: body.name,
          industry: body.industry,
          timezone: body.timezone,
          currency: body.currency,
          country: body.country,
          locationName: body.locationName,
        });
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
      return created(summary);
    }),
  ];
}
