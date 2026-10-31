import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { HttpError } from "../../platform/http/errors";
import { route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { estimatePromptChars, loadAgentContext, maxSystemPromptChars, promptBudgetProblem } from "./agent";
import { noGrowth, type GrowthResolver } from "./growth";
import { getGrowthSettings, GrowthSettingsPatch, updateGrowthSettings } from "./growthSettings";
import { AiSettingsPatch, getAiSettings, updateAiSettings, type AiSettingsView } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de WhatsApp IA > Configuración del bot (módulo del plan `whatsapp`):
//
//   GET    /whatsapp/settings    cualquier rol del negocio (la primera lectura crea la fila
//                                con los defaults de la plantilla del rubro)
//   PATCH  /whatsapp/settings    dueño, admin. 422 `prompt_too_long` si el prompt del agente
//                                que resultaría (configuración + sucursales, servicios y
//                                equipo) pasa `AGENT_MAX_SYSTEM_PROMPT_CHARS` (agent/prompt.ts)
//   GET    /whatsapp/growth      crecimiento (I6): reseñas, rescate de cotizaciones y upsell,
//                                con lo que el plan permite (`allowed`)
//   PATCH  /whatsapp/growth      dueño, admin (403 `module_not_in_plan` si el plan no lo trae)
//
// Forma: { tone, register: "vos"|"tu"|"usted", instructions,
//          knowledge: [{ id, title, items: string[] }], faq: [{ question, answer }],
//          texts: Record<string, string> }
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsappSettingsRouteDeps {
  db: Executor;
  /** Lo de crecimiento que permite el plan (la composición lo arma desde billing). Default: nada. */
  getGrowth?: GrowthResolver;
}

export function settingsRoutes({ db, getGrowth = noGrowth }: WhatsappSettingsRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/whatsapp/settings", auth: "user", module: "whatsapp" }, ({ session }) =>
      getAiSettings(db, session.businessId),
    ),
    route(
      { method: "PATCH", path: "/whatsapp/settings", auth: "user", roles: MANAGER_ROLES, module: "whatsapp", body: AiSettingsPatch },
      async ({ session, body }) => {
        // Catálogo y equipo actuales; la configuración es la que quedaría con el cambio.
        const ctx = await loadAgentContext(db, session.businessId);
        const maxChars = maxSystemPromptChars();
        const currentChars = ctx ? estimatePromptChars(ctx) : 0;
        const validate = (settings: AiSettingsView) => {
          const problem = ctx ? promptBudgetProblem({ ...ctx, settings }, maxChars, currentChars) : null;
          if (problem) throw new HttpError(422, problem, "prompt_too_long");
        };
        return updateAiSettings(db, session, body, { validate });
      },
    ),
    route({ method: "GET", path: "/whatsapp/growth", auth: "user", module: "whatsapp" }, async ({ session }) =>
      getGrowthSettings(db, session.businessId, await getGrowth(session.businessId)),
    ),
    route(
      { method: "PATCH", path: "/whatsapp/growth", auth: "user", roles: MANAGER_ROLES, module: "whatsapp", body: GrowthSettingsPatch },
      async ({ session, body }) => updateGrowthSettings(db, session, await getGrowth(session.businessId), body),
    ),
  ];
}
