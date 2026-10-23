import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { appRuntimeRole, systemOnlyPolicy, tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo team: usuarios del panel, su membresía (rol) en cada negocio y a qué sucursales
// entran; profesionales con su horario semanal por sucursal y ausencias
// (PLAN-GESTION.md §2 y §4).
//
// Un usuario (persona, con email) puede pertenecer a varios negocios; un profesional
// (quien atiende citas) puede existir sin usuario (el dueño carga a su equipo sin
// invitarlo) y se enlaza a una membresía cuando el profesional entra con su usuario.
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBERSHIP_ROLES = ["owner", "admin", "front_desk", "staff"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

// ─────────────────────────────────────────────────────────────────────────────
// Usuarios. No tienen `business_id`: el email es único en toda la plataforma y una
// persona puede estar en varios negocios. Por eso su política no es la estándar:
//   • contexto de sistema → todo (login por email, invitaciones, superadmin);
//   • contexto de un negocio → solo los usuarios con membresía en ESE negocio (la
//     lista del equipo). El subquery a `memberships` pasa a su vez por la política de
//     memberships, que filtra por el mismo negocio.
// Crear un usuario nuevo es siempre de sistema (todavía no tiene membresía que lo haga
// visible): es parte del flujo de invitación de I0.6.
// ─────────────────────────────────────────────────────────────────────────────
const USER_VISIBLE = sql.raw(
  "current_setting('app.system', true) = 'on' OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id " +
    "AND m.business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)",
);

export const users = pgTable(
  "users",
  {
    id: uuidPk(),
    // Siempre en minúsculas (lo exige el CHECK): el login compara por igualdad y usa el índice.
    email: text("email").notNull(),
    name: text("name").notNull(),
    // "salt:hash" scrypt (src/platform/auth/password.ts). null = invitado que todavía no
    // eligió su clave.
    passwordHash: text("password_hash"),
    // Secreto TOTP del 2FA opcional, cifrado con src/platform/crypto/secrets.ts. Puede
    // existir sin estar activo (se generó en /auth/totp/setup y falta confirmarlo con un
    // código): el 2FA rige solo con `totp_enabled_at`.
    totpSecret: text("totp_secret"),
    // Cuándo se activó el 2FA (null = no se pide código al entrar).
    totpEnabledAt: instant("totp_enabled_at"),
    // Revocación de sesiones: el token lleva el epoch con el que se firmó; cambiar clave,
    // rol o estado lo incrementa y todo token viejo deja de valer en la próxima request.
    sessionEpoch: integer("session_epoch").notNull().default(0),
    // El panel exige elegir una clave nueva antes de seguir (p. ej. tras una clave
    // temporal puesta por soporte). Cambiarla o restablecerla lo apaga.
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    // Correo SIN verificar desde este instante (alta self-service, I6): no puede entrar al
    // panel hasta abrir el enlace del correo (o restablecer la clave, que también prueba que
    // el correo es suyo). null = verificado o nunca hizo falta (invitaciones: aceptar el
    // enlace ya prueba el correo).
    emailUnverifiedSince: instant("email_unverified_since"),
    active: boolean("active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_email_check", sql`${t.email} = lower(${t.email}) AND position('@' in ${t.email}) > 1`),
    pgPolicy("member_or_system", { for: "all", to: appRuntimeRole, using: USER_VISIBLE, withCheck: USER_VISIBLE }),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Membresía: el rol de un usuario dentro de un negocio. Un usuario tiene a lo sumo una
// membresía por negocio.
// ─────────────────────────────────────────────────────────────────────────────
export const memberships = pgTable(
  "memberships",
  {
    id: uuidPk(),
    businessId: businessId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("memberships_business_user_uq").on(t.businessId, t.userId),
    // Login: "¿en qué negocios está este usuario?".
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_check", oneOf(t.role, MEMBERSHIP_ROLES)),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Sucursales a las que entra una membresía. SIN filas = todas las sucursales (el caso de
// dueño y admin); con filas, solo esas (recepción y profesional quedan fijos a las suyas).
// ─────────────────────────────────────────────────────────────────────────────
export const membershipLocations = pgTable(
  "membership_locations",
  {
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    businessId: businessId(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.locationId] }),
    index("membership_locations_location_idx").on(t.locationId),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Profesionales: quienes atienden las citas (la columna del EXCLUDE de las citas). Se
// desactivan en vez de borrarse: las citas, pagos y comisiones los referencian.
// ─────────────────────────────────────────────────────────────────────────────
export const staff = pgTable(
  "staff",
  {
    id: uuidPk(),
    businessId: businessId(),
    // Usuario del profesional (cuando entra con el suyo). Una membresía es a lo sumo un
    // profesional. SET NULL: quitarle el acceso no borra su agenda ni su historial.
    membershipId: uuid("membership_id").references(() => memberships.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // Color de la columna en la agenda (hex "#rrggbb").
    color: text("color"),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("staff_business_idx").on(t.businessId, t.position),
    uniqueIndex("staff_membership_uq").on(t.membershipId),
    check("staff_color_check", sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Horario semanal de cada profesional POR SUCURSAL (lunes en una, martes en otra). Mismo
// criterio que location_hours: 0 = domingo … 6 = sábado, varias filas por día = turnos
// partidos, horas locales de la sucursal.
// ─────────────────────────────────────────────────────────────────────────────
export const staffHours = pgTable(
  "staff_hours",
  {
    id: uuidPk(),
    businessId: businessId(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("staff_hours_staff_idx").on(t.staffId, t.weekday),
    index("staff_hours_location_idx").on(t.locationId, t.weekday),
    check("staff_hours_weekday_check", sql`${t.weekday} BETWEEN 0 AND 6`),
    check("staff_hours_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Ausencias y cierres: feriados, vacaciones e incapacidades en una sola tabla.
//   • sin sucursal ni profesional → cierra el negocio entero (feriado);
//   • con sucursal → cierra esa sucursal;
//   • con profesional → ausencia de esa persona (en todas las sucursales, o en una sola
//     si además trae sucursal).
// Vive en team (§2 "ausencias") y no en business: así business no depende de team.
// ─────────────────────────────────────────────────────────────────────────────
export const timeOff = pgTable(
  "time_off",
  {
    id: uuidPk(),
    businessId: businessId(),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [
    index("time_off_business_starts_idx").on(t.businessId, t.startsAt),
    index("time_off_staff_starts_idx").on(t.staffId, t.startsAt),
    check("time_off_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Tokens de un solo uso que viajan por correo: recuperación de clave (vence en 1 h),
// invitación al equipo de un negocio (vence en 7 días) y verificación del correo del alta
// self-service (vence en 2 días). En la base queda solo el sha256
// del token (un dump no permite usar ningún link vigente); el token en claro existe solo
// en el correo. `used_at` lo marca un UPDATE atómico (`… WHERE used_at IS NULL`): dos
// clics simultáneos en el mismo link no lo consumen dos veces.
//
// Solo de sistema: se leen ANTES de que exista una sesión (el link llega sin cookie) y
// ningún negocio tiene por qué ver los tokens de nadie.
// ─────────────────────────────────────────────────────────────────────────────
export const AUTH_TOKEN_KINDS = ["password_reset", "invitation", "email_verification"] as const;
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number];

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuidPk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Negocio de la invitación o del alta (null en la recuperación de clave: la cuenta es de la plataforma).
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // sha256 (hex) del token que va en el link.
    tokenHash: text("token_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    usedAt: instant("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_tokens_token_hash_uq").on(t.tokenHash),
    // "Invalidar los links anteriores de esta persona" al emitir uno nuevo.
    index("auth_tokens_user_kind_idx").on(t.userId, t.kind),
    check("auth_tokens_kind_check", oneOf(t.kind, AUTH_TOKEN_KINDS)),
    check("auth_tokens_invitation_business_check", sql`${t.kind} <> 'invitation' OR ${t.businessId} IS NOT NULL`),
    systemOnlyPolicy(),
  ],
).enableRLS();

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type MembershipLocation = typeof membershipLocations.$inferSelect;
export type NewMembershipLocation = typeof membershipLocations.$inferInsert;
export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
export type StaffHour = typeof staffHours.$inferSelect;
export type NewStaffHour = typeof staffHours.$inferInsert;
export type TimeOff = typeof timeOff.$inferSelect;
export type NewTimeOff = typeof timeOff.$inferInsert;
export type AuthToken = typeof authTokens.$inferSelect;
export type NewAuthToken = typeof authTokens.$inferInsert;
