import { eq, sql } from "drizzle-orm";
import { recordLoginSuccess } from "../../platform/auth/loginRateLimit";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../../platform/auth/password";
import type { SessionClaims } from "../../platform/auth/sessionToken";
import { consumeTotp } from "../../platform/auth/totp";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { decrypt } from "../../platform/crypto/secrets";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import {
  activeMemberships,
  findUserByEmail,
  findUserById,
  guardCredentialAttempt,
  hasMembershipInPausedBusiness,
  normalizeEmail,
  recordCredentialFailure,
} from "./identity";
import { businessPaused } from "./session";
import { users, type User } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Login por email, cambio de negocio y cambio de clave.
//
// Login (lecciones del panel viejo, legacy/src/panel/rutas/acceso.ts):
//   • Rate limit ANTES de scrypt, con la clave "por usuario" = el email tal cual se
//     intentó (exista o no la cuenta): el 429 no es un oráculo de qué cuentas existen.
//   • scrypt SIEMPRE (DUMMY_HASH si el usuario no existe o todavía no eligió clave) y el
//     MISMO 401 genérico para "no existe", "clave mala", "cuenta inactiva" y "código malo".
//   • El 2FA se pide recién con la clave correcta (`totp_required`): así un código
//     equivocado de alguien sin la clave no gasta el anti-replay ni revela nada.
//   • El login NO sube el epoch: entrar desde otro dispositivo no echa a los demás. Solo
//     cambiar clave, rol o estado revoca sesiones.
// ─────────────────────────────────────────────────────────────────────────────

const invalidCredentials = () => new HttpError(401, "Correo o clave incorrectos.", "invalid_credentials");

/** La clave actual no coincide (400, no 401: la sesión SÍ es válida y el panel trata todo 401 como "sesión vencida"). */
export const invalidPassword = () => new HttpError(400, "La clave actual no es correcta.", "invalid_password");

export type LoginResult = { status: "totp_required" } | { status: "ok"; claims: SessionClaims };

/** ¿El código TOTP vale para esta cuenta (con su 2FA activo)? Consume el código (anti-replay). */
export function verifyUserTotp(user: User, code: string | undefined): boolean {
  if (!user.totpEnabledAt || !user.totpSecret || !code) return false;
  return consumeTotp(decrypt(user.totpSecret), code) === "ok";
}

export async function login(
  db: Executor,
  input: { email: string; password: string; totpCode?: string; ip: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  guardCredentialAttempt(input.ip, "login", email);

  const user = await findUserByEmail(db, email);
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !passwordOk || !user.active) {
    recordCredentialFailure(input.ip, "login", email);
    throw invalidCredentials();
  }

  if (user.totpEnabledAt) {
    const code = input.totpCode?.trim();
    if (!code) return { status: "totp_required" };
    if (!verifyUserTotp(user, code)) {
      recordCredentialFailure(input.ip, "login", email);
      throw invalidCredentials();
    }
  }

  // Credenciales correctas: recién acá se puede explicar por qué no entra (no es un oráculo).
  const memberships = await activeMemberships(db, user.id);
  if (memberships.length === 0) {
    // Su único negocio está pausado (cobro manual): se lo decimos, para que sepa qué hacer.
    if (await hasMembershipInPausedBusiness(db, user.id)) throw businessPaused();
    throw new HttpError(
      403,
      "Tu cuenta no tiene acceso a ningún negocio activo. Hablá con quien administra tu negocio.",
      "no_active_business",
    );
  }
  recordLoginSuccess(input.ip, "login", email);
  return { status: "ok", claims: { businessId: memberships[0].businessId, userId: user.id, sessionEpoch: user.sessionEpoch } };
}

/** Claims de la sesión en otro negocio de la misma persona (mismo epoch). 403 si no es miembro activo. */
export async function switchBusiness(db: Executor, session: Session, businessId: string): Promise<SessionClaims> {
  const target = businessId.toLowerCase();
  const memberships = await activeMemberships(db, session.userId);
  if (!memberships.some((m) => m.businessId === target)) {
    throw new HttpError(403, "No tenés acceso a ese negocio.", "business_forbidden");
  }
  return { businessId: target, userId: session.userId, sessionEpoch: session.sessionEpoch };
}

/**
 * Fija la clave de la cuenta, apaga el cambio obligatorio y sube el epoch (revoca todas
 * las sesiones). Corre con el contexto de `tx`. Devuelve el epoch nuevo.
 */
export async function setPassword(tx: Tx, userId: string, passwordHash: string): Promise<number> {
  const [row] = await tx
    .update(users)
    .set({ passwordHash, mustChangePassword: false, sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionEpoch: users.sessionEpoch });
  if (!row) throw new Error("setPassword: el usuario no existe o no es visible en este contexto");
  return row.sessionEpoch;
}

/**
 * Cambio de clave con la sesión iniciada. Revoca las demás sesiones (sube el epoch) y
 * devuelve los claims con el epoch nuevo para re-emitir la cookie de ESTE dispositivo
 * (acaba de probar la clave: se queda adentro).
 */
export async function changePassword(
  db: Executor,
  session: Session,
  input: { currentPassword: string; newPassword: string; ip: string },
): Promise<SessionClaims> {
  guardCredentialAttempt(input.ip, "password", session.userId);
  const user = await findUserById(db, session.userId);
  const ok = await verifyPassword(input.currentPassword, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordCredentialFailure(input.ip, "password", session.userId);
    throw invalidPassword();
  }
  if (input.newPassword === input.currentPassword) {
    throw new ValidationError({ "body.newPassword": "La clave nueva tiene que ser distinta de la actual." });
  }
  const passwordHash = await hashPassword(input.newPassword);
  const sessionEpoch = await withTenant(db, session.businessId, async (tx) => {
    const epoch = await setPassword(tx, user.id, passwordHash);
    await recordAudit(tx, session.businessId, "password_changed", userActor(user.id));
    return epoch;
  });
  return { businessId: session.businessId, userId: user.id, sessionEpoch };
}
