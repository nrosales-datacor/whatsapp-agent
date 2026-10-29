import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { AiSettingsPatch, getAiSettings, updateAiSettings } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de WhatsApp IA > Configuración del bot (módulo del plan `whatsapp`):
//
//   GET    /whatsapp/settings    cualquier rol del negocio (la primera lectura crea la fila
//                                con los defaults de la plantilla del rubro)
//   PATCH  /whatsapp/settings    dueño, admin
//
// Forma: { tone, register: "vos"|"tu"|"usted", instructions,
//          knowledge: [{ id, title, items: string[] }], faq: [{ question, answer }],
//          texts: Record<string, string> }
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsappSettingsRouteDeps {
  db: Executor;
}

export function settingsRoutes({ db }: WhatsappSettingsRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/whatsapp/settings", auth: "user", module: "whatsapp" }, ({ session }) =>
      getAiSettings(db, session.businessId),
    ),
    route(
      { method: "PATCH", path: "/whatsapp/settings", auth: "user", roles: MANAGER_ROLES, module: "whatsapp", body: AiSettingsPatch },
      ({ session, body }) => updateAiSettings(db, session, body),
    ),
  ];
}
