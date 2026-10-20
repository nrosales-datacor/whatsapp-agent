// API pública del módulo team: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I1.
export type {
  Membership,
  MembershipLocation,
  MembershipRole,
  NewMembership,
  NewMembershipLocation,
  NewStaff,
  NewStaffHour,
  NewTimeOff,
  NewUser,
  Staff,
  StaffHour,
  TimeOff,
  User,
} from "./schema";
