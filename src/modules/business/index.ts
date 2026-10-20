// API pública del módulo business: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts): tipos, el caché del contexto del negocio,
// el alta/listado de negocios del superadmin, las rutas de Configuración y la API de
// sucursales y horarios que usan la agenda y el agente.
export { getBusinessContext, invalidateBusinessContext } from "./context";
export type { BusinessContext, LocationWithHours } from "./context";
export type { BusinessLegalInfo, BusinessSettings } from "./businessSettings";
export {
  checkWeeklyBlocks,
  fromDbTime,
  MAX_BLOCKS_PER_DAY,
  minutesOfDay,
  overlappingBlocks,
  sortBlocks,
  WeeklyBlockSchema,
  WeeklyHoursSchema,
} from "./hours";
export type { WeeklyBlock } from "./hours";
export { assertLocationsOfBusiness, getLocation, getLocationWeeklyHours, listLocations } from "./locations";
export type { DeleteLocationResult, LocationReferenceCheck, LocationView } from "./locations";
export { businessRoutes, type BusinessRouteDeps } from "./routes";
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
