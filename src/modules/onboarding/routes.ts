import type { Executor } from "../../platform/db/scope";
import { noContent, reply, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import type { PlanHooks } from "../../platform/plan/planHooks";
import { getClientIp } from "../../platform/net/clientIp";
import { log } from "../../platform/observability/log";
import { startPanelSession, type LoginHook } from "../team";
import { dismissChecklist, getOnboarding, type ChecklistDeps } from "./checklist";
import { ResendInput, resendVerification, signup, SignupInput, signupOptions, verifySignup, VerifyInput, type SignupDeps } from "./signup";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas del alta self-service y de la checklist de primeros pasos (I6):
//
//   GET  /signup/options      públicas: rubros (de las plantillas) y días de prueba
//   POST /signup              públicas: alta → 202 { status: "verification_sent" } siempre
//   POST /signup/verify       públicas: { token } → verifica, deja la sesión y devuelve `me`
//                             (cuenta como login en `daily_usage`, igual que /auth/login)
//   POST /signup/resend       públicas: { email } → 204 siempre
//   GET  /onboarding          dueño y admin: pasos y si se muestra
//   POST /onboarding/dismiss  dueño y admin: descartar la checklist
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingRouteDeps extends SignupDeps {
  db: Executor;
  /** Plan del negocio (`me.plan` al verificar y los módulos para la checklist). */
  plans: Pick<PlanHooks, "snapshot" | "enabledModules">;
  /** ¿Tiene WhatsApp conectado? (módulo WhatsApp, lo inyecta src/routes.ts). */
  isWhatsAppConnected: ChecklistDeps["isWhatsAppConnected"];
  /**
   * Aviso del primer ingreso al verificar el correo (la composición lo cuenta en
   * `daily_usage` como un login, igual que el de team). Sus errores no cortan el ingreso.
   */
  onLogin?: LoginHook;
}

/** Las altas pesan poco: tope chico al cuerpo. */
const SIGNUP_MAX_BODY = 8 * 1024;

export function onboardingRoutes({ db, plans, isWhatsAppConnected, onLogin, ...signupDeps }: OnboardingRouteDeps): Route[] {
  const checklistDeps: ChecklistDeps = { enabledModules: (businessId) => plans.enabledModules(businessId), isWhatsAppConnected };
  return [
    route({ method: "GET", path: "/signup/options", auth: "public" }, () => signupOptions()),

    route({ method: "POST", path: "/signup", auth: "public", body: SignupInput, maxBodyBytes: SIGNUP_MAX_BODY }, async ({ req, body }) =>
      reply(202, await signup(db, { ...body, ip: getClientIp(req) }, signupDeps)),
    ),

    route({ method: "POST", path: "/signup/verify", auth: "public", body: VerifyInput, maxBodyBytes: SIGNUP_MAX_BODY }, async ({ res, body }) => {
      const claims = await verifySignup(db, body.token, signupDeps);
      const me = await startPanelSession(db, res, claims, plans);
      // El enlace deja la sesión: es el primer ingreso de la dueña (hito de activación).
      if (onLogin) {
        try {
          await onLogin(db, claims.businessId, claims.userId);
        } catch (error) {
          log.warn("login_hook_failed", { businessId: claims.businessId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return me;
    }),

    route({ method: "POST", path: "/signup/resend", auth: "public", body: ResendInput, maxBodyBytes: SIGNUP_MAX_BODY }, async ({ req, body }) => {
      await resendVerification(db, { email: body.email, ip: getClientIp(req) });
      return noContent();
    }),

    route({ method: "GET", path: "/onboarding", auth: "user", roles: ["owner", "admin"] }, ({ session }) =>
      getOnboarding(db, session.businessId, checklistDeps),
    ),

    route({ method: "POST", path: "/onboarding/dismiss", auth: "user", roles: ["owner", "admin"] }, ({ session }) =>
      dismissChecklist(db, session.businessId, checklistDeps),
    ),
  ];
}
