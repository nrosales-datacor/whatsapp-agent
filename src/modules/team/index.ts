// API pública del módulo team: lo único que otros módulos (y la composición en src/) pueden
// importar de acá (test/architecture/moduleBoundaries.test.ts).
export { inviteMember, ACCEPT_INVITATION_PATH } from "./invitations";
export type { InviteInput, InvitationInfo } from "./invitations";
export type { EnabledModules, Me } from "./me";
export { isLocationAssigned } from "./members";
export type { Member, MemberStatus } from "./members";
export { RESET_PASSWORD_PATH } from "./recovery";
export { createSessionResolver } from "./session";
export { listStaffOptions, type StaffOption } from "./staffDirectory";
export { teamRoutes, type TeamRouteDeps } from "./routes";
// Profesionales, horarios y ausencias (Configuración > Equipo y API pública de la agenda).
export { getStaffMember, getStaffWeeklyHours, listStaff, STAFF_COLORS } from "./staff";
export type { DeleteStaffResult, StaffMember, StaffView, StaffWeeklyBlock } from "./staff";
export { staffRoutes, type StaffRouteDeps } from "./staffRoutes";
export { listTimeOff } from "./timeOff";
export type { TimeOffEntry, TimeOffScope } from "./timeOff";
export type {
  AuthToken,
  AuthTokenKind,
  Membership,
  MembershipLocation,
  MembershipRole,
  NewAuthToken,
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
