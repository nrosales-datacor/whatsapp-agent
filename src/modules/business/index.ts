// API pública del módulo business: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts): tipos, el caché del contexto del negocio,
// el alta/listado de negocios del superadmin, las plantillas de rubro, las rutas de
// Configuración y la API de sucursales y horarios que usan la agenda y el agente.
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
export {
  applyIndustryTemplate,
  createBusiness,
  DEFAULT_LOCATION_HOURS,
  isValidTimeZone,
  listBusinesses,
  slugify,
  summarizeBusiness,
} from "./provisioning";
export type { BusinessSummary, CreatedBusiness, NewBusinessInput, ProvisioningSteps } from "./provisioning";
export { businessRoutes, type BusinessRouteDeps } from "./routes";
export {
  AI_REGISTERS,
  INDUSTRIES,
  isIndustry,
  listIndustryTemplates,
  loadIndustryTemplate,
  parseIndustryTemplate,
  REMINDER_PLACEHOLDERS,
} from "./templates";
export type {
  Industry,
  IndustryTemplate,
  TemplateAi,
  TemplateCatalog,
  TemplateCategory,
  TemplateCustomField,
  TemplateService,
} from "./templates";
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
