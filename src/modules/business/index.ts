// API pública del módulo business: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos, el caché del contexto
// del negocio y el alta/listado de negocios del superadmin; crece en I1.
export { getBusinessContext, invalidateBusinessContext } from "./context";
export type { BusinessContext, LocationWithHours } from "./context";
export {
  createBusiness,
  DEFAULT_LOCATION_HOURS,
  INDUSTRIES,
  isValidTimeZone,
  listBusinesses,
  slugify,
  summarizeBusiness,
} from "./provisioning";
export type { BusinessSummary, CreatedBusiness, Industry, NewBusinessInput } from "./provisioning";
export type {
  Business,
  BusinessStatus,
  CustomField,
  CustomFieldEntity,
  CustomFieldType,
  Location,
  LocationHour,
  NewBusiness,
  NewCustomField,
  NewLocation,
  NewLocationHour,
  Plan,
} from "./schema";
export type { Branding, ClientStatusRules, ExtraModules, ReminderChannel, Terminology } from "./settings";
