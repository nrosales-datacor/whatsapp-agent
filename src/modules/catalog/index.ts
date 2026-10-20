// API pública del módulo catalog: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I1.
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
