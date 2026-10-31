// API pública del módulo team: lo único que otros módulos (y la composición en src/) pueden
// importar de acá (test/architecture/moduleBoundaries.test.ts).
export { inviteMember, ACCEPT_INVITATION_PATH } from "./invitations";
export type { InviteInput, InvitationInfo } from "./invitations";
export type { Me } from "./me";
export { activeMemberSessionEpochs, countActiveMembers, isLocationAssigned } from "./members";
export type { Member, MemberStatus } from "./members";
export { RESET_PASSWORD_PATH } from "./recovery";
// Alta self-service (I6.7): la cuenta dueña sin verificar y la verificación del correo.
export { guardCredentialAttempt, NewPasswordSchema, normalizeEmail, recordCredentialFailure } from "./identity";
export { createSelfServiceOwner, emailHasAccount, noticeExistingAccount, VERIFY_EMAIL_PATH } from "./verification";
export type { SelfServiceOwnerInput } from "./verification";
export { createSessionResolver, type SessionSeenHook } from "./session";
// Términos y aviso de privacidad (Carril P): aceptación versionada (alta, invitación y el aviso del panel).
export { getLegalStatus, latestLegalAcceptance, recordLegalAcceptance } from "./legal";
export type { LegalAcceptanceRecord, LegalStatus } from "./legal";
// Reportes e Inicio (I5): minutos disponibles por profesional (ocupación) y último día de actividad.
export { getStaffAvailableMinutes, markMemberActive, type LocationSchedule } from "./availability";
export { getStaffIdForUser, listStaffOptions, type StaffOption } from "./staffDirectory";
export { teamRoutes, type LoginHook, type TeamRouteDeps } from "./routes";
// Profesionales, horarios y ausencias (Configuración > Equipo y API pública de la agenda).
export { countActiveStaff, getStaffMember, getStaffWeeklyHours, listStaff, STAFF_COLORS } from "./staff";
export type { DeleteStaffResult, StaffMember, StaffView, StaffWeeklyBlock } from "./staff";
export { staffRoutes, type StaffRouteDeps } from "./staffRoutes";
export { listTimeOff } from "./timeOff";
export type { TimeOffEntry, TimeOffScope } from "./timeOff";
export type {
  AuthToken,
  AuthTokenKind,
  LegalAcceptance,
  LegalAcceptanceContext,
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
