// API pública del módulo team: lo único que otros módulos (y la composición en src/) pueden
// importar de acá (test/architecture/moduleBoundaries.test.ts).
export { inviteMember, ACCEPT_INVITATION_PATH } from "./invitations";
export type { InviteInput, InvitationInfo } from "./invitations";
export type { EnabledModules, Me } from "./me";
export type { Member, MemberStatus } from "./members";
export { RESET_PASSWORD_PATH } from "./recovery";
export { createSessionResolver } from "./session";
export { teamRoutes, type TeamRouteDeps } from "./routes";
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
