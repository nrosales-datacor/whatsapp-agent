import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { canManage, MANAGER_ROLES } from "../../platform/http/access";
import { created, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { assertFullClients, type ClientsTierHook } from "../../platform/plan/planHooks";
import { getClientRules, updateClientRules, type IndustryRulesLookup } from "./clientRules";
import {
  archiveCustomField,
  createCustomField,
  CustomFieldOrderInput,
  CustomFieldPatch,
  listCustomFields,
  NewCustomFieldInput,
  reorderCustomFields,
  updateCustomField,
} from "./customFields";
import { CUSTOM_FIELD_ENTITIES } from "./schema";
import { ClientStatusRulesInput } from "./statusRules";
import { isIndustry, loadIndustryTemplate } from "./templates";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del CRM de clientes (I3, plan Pro: nivel `full` de clientes):
//
//   GET    /settings/client-rules          reglas del estado del cliente + las del rubro (dueño, admin)
//   PUT    /settings/client-rules          reemplaza las reglas (dueño, admin)
//   GET    /settings/custom-fields         ?entity&includeInactive (todos los roles: el
//                                          formulario de la ficha y de la cita las necesita;
//                                          los desactivados solo dueño/admin)
//   POST   /settings/custom-fields         alta (dueño, admin)
//   PUT    /settings/custom-fields/order   { entity, ids } (dueño, admin)
//   PATCH  /settings/custom-fields/:id     nombre, tipo compatible, opciones, obligatorio, activo (dueño, admin)
//   DELETE /settings/custom-fields/:id     desactiva: lo cargado se conserva (dueño, admin)
//
// Gate: el nivel de clientes del plan (`PlanHooks.clientsTier`, lo inyecta la composición
// desde modules/billing); en el Básico todas responden 403 `module_not_in_plan`.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientSettingsRouteDeps {
  db: Executor;
  plans: ClientsTierHook;
}

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeInactive: z
    .enum(["1", "0", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

/** Reglas de la plantilla del rubro del negocio (un rubro sin plantilla usa la genérica). */
const industryRules: IndustryRulesLookup = (industry) => ({ ...loadIndustryTemplate(isIndustry(industry) ? industry : "generic").clientStatusRules });

export function clientSettingsRoutes({ db, plans }: ClientSettingsRouteDeps): Route[] {
  const gate = (businessId: string) => assertFullClients(plans, businessId);
  return [
    route({ method: "GET", path: "/settings/client-rules", auth: "user", roles: MANAGER_ROLES }, async ({ session }) => {
      await gate(session.businessId);
      return getClientRules(db, session.businessId, industryRules);
    }),

    route(
      { method: "PUT", path: "/settings/client-rules", auth: "user", roles: MANAGER_ROLES, body: ClientStatusRulesInput },
      async ({ session, body }) => {
        await gate(session.businessId);
        return updateClientRules(db, session, body, industryRules);
      },
    ),

    route({ method: "GET", path: "/settings/custom-fields", auth: "user", query: ListQuery }, async ({ session, query }) => {
      await gate(session.businessId);
      return listCustomFields(db, session.businessId, { entity: query.entity, includeInactive: query.includeInactive && canManage(session.role) });
    }),

    route(
      { method: "POST", path: "/settings/custom-fields", auth: "user", roles: MANAGER_ROLES, body: NewCustomFieldInput },
      async ({ session, body }) => {
        await gate(session.businessId);
        return created(await createCustomField(db, session, body));
      },
    ),

    route(
      { method: "PUT", path: "/settings/custom-fields/order", auth: "user", roles: MANAGER_ROLES, body: CustomFieldOrderInput },
      async ({ session, body }) => {
        await gate(session.businessId);
        return reorderCustomFields(db, session, body);
      },
    ),

    route(
      { method: "PATCH", path: "/settings/custom-fields/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: CustomFieldPatch },
      async ({ session, params, body }) => {
        await gate(session.businessId);
        return updateCustomField(db, session, params.id, body);
      },
    ),

    route(
      { method: "DELETE", path: "/settings/custom-fields/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      async ({ session, params }) => {
        await gate(session.businessId);
        return archiveCustomField(db, session, params.id);
      },
    ),
  ];
}
