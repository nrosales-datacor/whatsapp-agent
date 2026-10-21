import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { created, noContent, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import {
  CategoryInput,
  CategoryOrderInput,
  createCategory,
  createService,
  deleteCategory,
  deleteService,
  getCatalog,
  NewServiceInput,
  renameCategory,
  reorderCategories,
  reorderServices,
  ServiceOrderInput,
  ServicePatch,
  updateService,
} from "./services";
import { getStaffServices, replaceStaffServices, StaffServicesInput } from "./staffServices";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Configuración > Servicios (I1). Leen todos los roles; editan dueño y
// administración. Montos siempre en céntimos.
//
//   GET    /settings/services                       categorías + servicios
//   POST   /settings/service-categories             dueño, admin
//   PUT    /settings/service-categories/order       dueño, admin ({ ids } en el orden nuevo)
//   PATCH  /settings/service-categories/:id         dueño, admin (renombrar)
//   DELETE /settings/service-categories/:id         dueño, admin (sus servicios quedan sin categoría)
//   POST   /settings/services                       dueño, admin
//   PUT    /settings/services/order                 dueño, admin ({ categoryId, ids })
//   PATCH  /settings/services/:id                   dueño, admin
//   DELETE /settings/services/:id                   dueño, admin
//   GET    /settings/staff/:id/services             servicios que hace un profesional
//   PUT    /settings/staff/:id/services             dueño, admin (lista vacía = todos)
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogRouteDeps {
  db: Executor;
}

const IdParams = z.object({ id: z.uuid() });

export function catalogRoutes({ db }: CatalogRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/settings/services", auth: "user" }, ({ session }) => getCatalog(db, session.businessId)),

    // ── Categorías ──
    route(
      { method: "POST", path: "/settings/service-categories", auth: "user", roles: MANAGER_ROLES, body: CategoryInput },
      async ({ session, body }) => created(await createCategory(db, session, body.name)),
    ),

    route(
      { method: "PUT", path: "/settings/service-categories/order", auth: "user", roles: MANAGER_ROLES, body: CategoryOrderInput },
      ({ session, body }) => reorderCategories(db, session, body.ids),
    ),

    route(
      { method: "PATCH", path: "/settings/service-categories/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: CategoryInput },
      ({ session, params, body }) => renameCategory(db, session, params.id, body.name),
    ),

    route(
      { method: "DELETE", path: "/settings/service-categories/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      async ({ session, params }) => {
        await deleteCategory(db, session, params.id);
        return noContent();
      },
    ),

    // ── Servicios ──
    route(
      { method: "POST", path: "/settings/services", auth: "user", roles: MANAGER_ROLES, body: NewServiceInput },
      async ({ session, body }) => created(await createService(db, session, body)),
    ),

    route(
      { method: "PUT", path: "/settings/services/order", auth: "user", roles: MANAGER_ROLES, body: ServiceOrderInput },
      ({ session, body }) => reorderServices(db, session, body),
    ),

    route(
      { method: "PATCH", path: "/settings/services/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: ServicePatch },
      ({ session, params, body }) => updateService(db, session, params.id, body),
    ),

    route(
      { method: "DELETE", path: "/settings/services/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      async ({ session, params }) => {
        await deleteService(db, session, params.id);
        return noContent();
      },
    ),

    // ── Servicios de un profesional ──
    route({ method: "GET", path: "/settings/staff/:id/services", auth: "user", params: IdParams }, ({ session, params }) =>
      getStaffServices(db, session.businessId, params.id),
    ),

    route(
      { method: "PUT", path: "/settings/staff/:id/services", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: StaffServicesInput },
      ({ session, params, body }) => replaceStaffServices(db, session, params.id, body.services),
    ),
  ];
}
