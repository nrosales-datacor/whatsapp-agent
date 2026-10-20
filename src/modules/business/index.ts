// API pública del módulo business: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I1.
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
