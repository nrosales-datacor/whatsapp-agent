import type { ServerResponse } from "node:http";
import { z } from "zod";
import { ROLES, type SessionClaims } from "../../platform/auth/sessionToken";
import { userActor } from "../../platform/audit/auditLog";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { created, noContent, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { log } from "../../platform/observability/log";
import type { PlanHooks } from "../../platform/plan/planHooks";
import { getClientIp } from "../../platform/net/clientIp";
import { getBusinessContext } from "../business";
import { changePassword, login, switchBusiness } from "./auth";
import { findUserById, NewPasswordSchema, PasswordInputSchema, TotpCodeSchema } from "./identity";
import { acceptInvitation, getInvitation, inviteMember } from "./invitations";
import { buildMe, type Me } from "./me";
import { assertLocationsOfBusiness, listMembers, updateMember } from "./members";
import { requestPasswordReset, resetPassword } from "./recovery";
import { businessPaused, clearSessionCookie, setSessionCookie } from "./session";
import { startPanelSession } from "./sessionStart";
import { disableTotp, enableTotp, setupTotp } from "./twoFactor";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de identidad y equipo (I0.6):
//
//   /auth/*  login, logout, me, cambio de negocio, recuperación y cambio de clave, 2FA,
//            invitaciones (ver y aceptar). Públicas las que se usan sin sesión.
//   /team/*  invitar y gestionar el equipo del negocio (dueño y admin). Invitar o
//            reactivar a alguien pasando el cupo de usuarios del plan → 403
//            `plan_limit_reached` (el plan llega inyectado desde modules/billing).
//
// Respuestas con el sobre del router: `{ ok: true, data }` / `{ ok: false, error, code }`.
// Toda ruta que deja una sesión nueva (login, cambio de negocio, aceptar invitación,
// cambio de clave, activar/apagar 2FA) fija la cookie `panel_session` (HttpOnly).
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencias de las rutas del módulo (src/routes.ts las inyecta). */
export interface TeamRouteDeps {
  db: Executor;
  /** Plan del negocio (`me.plan`) y cupo de usuarios; lo inyecta la composición desde modules/billing. */
  plans: Pick<PlanHooks, "snapshot" | "quota" | "hasFeature">;
  /** Aviso de un login correcto (la composición lo cuenta en `daily_usage`). Sus errores no cortan el login. */
  onLogin?: LoginHook;
}

/** Aviso de un login correcto: negocio con el que entró y la persona. */
export type LoginHook = (executor: Executor, businessId: string, userId: string) => Promise<void> | void;

const Email = z.string().trim().min(1).max(320);
const Token = z.string().min(1).max(200);
const Name = z.string().trim().min(1).max(120);
const LocationIds = z.array(z.uuid()).max(200);

const LoginBody = z.object({ email: Email, password: PasswordInputSchema, totpCode: TotpCodeSchema.optional() });
const SwitchBusinessBody = z.object({ businessId: z.uuid() });
const ForgotBody = z.object({ email: Email });
const ResetBody = z.object({ token: Token, password: NewPasswordSchema });
const ChangePasswordBody = z.object({ currentPassword: PasswordInputSchema, newPassword: NewPasswordSchema });
const TotpEnableBody = z.object({ code: TotpCodeSchema.min(1) });
const TotpDisableBody = z.object({ password: PasswordInputSchema, code: TotpCodeSchema.min(1) });
const InvitationParams = z.object({ token: Token });
const AcceptInvitationBody = z.object({
  token: Token,
  // Obligatorio para una cuenta nueva; una cuenta que ya existe conserva su nombre.
  name: Name.optional(),
  password: PasswordInputSchema,
  // Solo si la cuenta ya existe y tiene 2FA.
  totpCode: TotpCodeSchema.optional(),
});
const InviteBody = z.object({
  email: z.email().max(320),
  name: Name.optional(),
  role: z.enum(ROLES),
  locationIds: LocationIds.optional(),
});
const MemberParams = z.object({ membershipId: z.uuid() });
const MemberPatchBody = z
  .object({ role: z.enum(ROLES).optional(), active: z.boolean().optional(), locationIds: LocationIds.optional() })
  .refine((b) => b.role !== undefined || b.active !== undefined || b.locationIds !== undefined, {
    message: "Indicá qué cambiar (rol, estado o sucursales).",
  });

export function teamRoutes({ db, plans, onLogin }: TeamRouteDeps): Route[] {
  /** Fija la cookie de la sesión nueva y devuelve su `me`. */
  const startSession = (res: ServerResponse, claims: SessionClaims): Promise<Me> => startPanelSession(db, res, claims, plans);

  return [
    // ── Sesión ──
    route({ method: "POST", path: "/auth/login", auth: "public", body: LoginBody }, async ({ req, res, body }) => {
      const result = await login(db, { ...body, ip: getClientIp(req) });
      if (result.status === "totp_required") return { status: "totp_required" as const };
      if (result.status === "paused") {
        // Pausado por el cobro: la sesión queda (solo para las rutas de pago) y el panel
        // muestra "Cuenta pausada" con el botón para pagar. No cuenta como login en
        // `daily_usage`: la persona no llega a usar el panel.
        setSessionCookie(res, result.claims);
        throw businessPaused();
      }
      const me = await startSession(res, result.claims);
      if (onLogin) {
        try {
          await onLogin(db, result.claims.businessId, result.claims.userId);
        } catch (error) {
          log.warn("login_hook_failed", { businessId: result.claims.businessId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { status: "ok" as const, me };
    }),

    route({ method: "POST", path: "/auth/logout", auth: "public" }, ({ res }) => {
      clearSessionCookie(res);
      return noContent();
    }),

    route({ method: "GET", path: "/auth/me", auth: "user" }, ({ session }) => buildMe(db, session, plans)),

    route(
      { method: "POST", path: "/auth/switch-business", auth: "user", body: SwitchBusinessBody },
      async ({ res, session, body }) => startSession(res, await switchBusiness(db, session, body.businessId)),
    ),

    // ── Clave ──
    route({ method: "POST", path: "/auth/password/forgot", auth: "public", body: ForgotBody }, async ({ req, body }) => {
      await requestPasswordReset(db, { email: body.email, ip: getClientIp(req) });
      return noContent();
    }),

    route({ method: "POST", path: "/auth/password/reset", auth: "public", body: ResetBody }, async ({ body }) => {
      await resetPassword(db, body);
      return noContent();
    }),

    route(
      { method: "POST", path: "/auth/password/change", auth: "user", body: ChangePasswordBody },
      async ({ req, res, session, body }) => {
        setSessionCookie(res, await changePassword(db, session, { ...body, ip: getClientIp(req) }));
        return noContent();
      },
    ),

    // ── Segundo factor ──
    route({ method: "POST", path: "/auth/totp/setup", auth: "user" }, ({ session }) => setupTotp(db, session)),

    route({ method: "POST", path: "/auth/totp/enable", auth: "user", body: TotpEnableBody }, async ({ req, res, session, body }) => {
      setSessionCookie(res, await enableTotp(db, session, { code: body.code, ip: getClientIp(req) }));
      return noContent();
    }),

    route({ method: "POST", path: "/auth/totp/disable", auth: "user", body: TotpDisableBody }, async ({ req, res, session, body }) => {
      setSessionCookie(res, await disableTotp(db, session, { ...body, ip: getClientIp(req) }));
      return noContent();
    }),

    // ── Invitaciones (lado de quien la recibe) ──
    route({ method: "GET", path: "/auth/invitations/:token", auth: "public", params: InvitationParams }, ({ params }) =>
      getInvitation(db, params.token),
    ),

    route(
      { method: "POST", path: "/auth/invitations/accept", auth: "public", body: AcceptInvitationBody },
      async ({ req, res, body }) => startSession(res, await acceptInvitation(db, { ...body, ip: getClientIp(req) })),
    ),

    // ── Equipo del negocio ──
    route(
      { method: "POST", path: "/team/invitations", auth: "user", roles: ["owner", "admin"], body: InviteBody },
      async ({ session, body }) => {
        if (body.role === "owner" && session.role !== "owner") {
          throw new HttpError(403, "Solo un dueño puede invitar a otro dueño.", "forbidden_role");
        }
        const locationIds = body.role === "owner" ? [] : (body.locationIds ?? []);
        await assertLocationsOfBusiness(db, session.businessId, locationIds);
        const [ctx, inviter, userLimit, branded] = await Promise.all([
          getBusinessContext(db, session.businessId),
          findUserById(db, session.userId),
          plans.quota(session.businessId, "users"),
          plans.hasFeature(session.businessId, "branding"),
        ]);
        if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
        const member = await inviteMember(db, {
          business: { id: ctx.business.id, name: ctx.business.name, brandColor: branded ? ctx.business.branding.accentColor : null },
          email: body.email,
          name: body.name,
          role: body.role,
          locationIds,
          invitedByName: inviter?.name ?? null,
          actor: userActor(session.userId),
          userLimit,
        });
        return created(member);
      },
    ),

    route({ method: "GET", path: "/team/members", auth: "user", roles: ["owner", "admin"] }, ({ session }) =>
      listMembers(db, session.businessId),
    ),

    route(
      {
        method: "PATCH",
        path: "/team/members/:membershipId",
        auth: "user",
        roles: ["owner", "admin"],
        params: MemberParams,
        body: MemberPatchBody,
      },
      async ({ res, session, params, body }) => {
        const userLimit = body.active === true ? await plans.quota(session.businessId, "users") : null;
        const { member, reissue } = await updateMember(db, session, params.membershipId, body, userLimit);
        if (reissue) setSessionCookie(res, reissue);
        return member;
      },
    ),
  ];
}
