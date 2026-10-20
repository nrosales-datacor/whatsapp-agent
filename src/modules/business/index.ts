// API pública del módulo business: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos y el caché del contexto
// del negocio; crece en I1.
export { getBusinessContext, invalidateBusinessContext } from "./context";
export type { BusinessContext, LocationWithHours } from "./context";
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
