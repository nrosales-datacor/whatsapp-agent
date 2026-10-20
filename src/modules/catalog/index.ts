// API pública del módulo catalog: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts): tipos, las rutas de Configuración >
// Servicios y la API que usan la agenda y el agente (servicios, overrides por
// profesional y quién puede atender).
export { catalogRoutes, type CatalogRouteDeps } from "./routes";
export { getService, getServices, isLocationRestrictingServices, MAX_PRICE_CENTS } from "./services";
export type { CatalogView, CategoryView, ServiceView } from "./services";
export { getStaffServiceOverrides, listBookableStaff } from "./staffServices";
export type { BookableStaff, EffectiveServiceTerms, StaffServiceOverride, StaffServicesView } from "./staffServices";
export type {
  NewService,
  NewServiceCategory,
  NewServiceLocation,
  NewStaffService,
  Service,
  ServiceCategory,
  ServiceLocation,
  StaffService,
} from "./schema";
