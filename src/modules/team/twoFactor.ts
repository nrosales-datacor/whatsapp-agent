import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DUMMY_HASH, verifyPassword } from "../../platform/auth/password";
import type { SessionClaims } from "../../platform/auth/sessionToken";
import { consumeTotp, encodeBase32, otpauthUri } from "../../platform/auth/totp";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { PRODUCT_NAME } from "../../platform/brand";
import { decrypt, encrypt } from "../../platform/crypto/secrets";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { invalidPassword, verifyUserTotp } from "./auth";
import { findUserById, guardCredentialAttempt, recordCredentialFailure } from "./identity";
import { users, type User } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Segundo factor (TOTP, RFC 6238) opcional de cada cuenta (PLAN-GESTION.md §2: 2FA
// opcional para dueños; lo puede activar cualquiera).
//
//   1. setup: genera un secreto nuevo (160 bits), lo guarda CIFRADO y lo devuelve una vez
//      (para el QR). Todavía no rige: falta confirmarlo.
//   2. enable { code }: con un código bueno de ese secreto, el 2FA pasa a regir desde el
//      próximo login (`totp_enabled_at`).
//   3. disable { password, code }: exige la clave Y un código vigente (una sesión robada
//      sola no alcanza para apagarlo).
//
// Activar o apagar el 2FA sube el epoch (cierra las demás sesiones: si había alguien más
// adentro, se va) y la cookie de este dispositivo se re-emite.
// ─────────────────────────────────────────────────────────────────────────────

const invalidCode = () => new HttpError(400, "El código no es correcto.", "invalid_code");

async function currentUser(db: Executor, session: Session): Promise<User> {
  const user = await findUserById(db, session.userId);
  if (!user) throw new HttpError(401, "Tu sesión no es válida o venció. Iniciá sesión de nuevo.", "unauthorized");
  return user;
}

export async function setupTotp(db: Executor, session: Session): Promise<{ secret: string; otpauthUrl: string }> {
  const user = await currentUser(db, session);
  if (user.totpEnabledAt) throw new HttpError(409, "El segundo factor ya está activo.", "totp_already_enabled");
  const secret = encodeBase32(crypto.randomBytes(20));
  await withTenant(db, session.businessId, (tx) =>
    tx
      .update(users)
      .set({ totpSecret: encrypt(secret) })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt))),
  );
  return { secret, otpauthUrl: otpauthUri(secret, user.email, PRODUCT_NAME) };
}

export async function enableTotp(db: Executor, session: Session, input: { code: string; ip: string }): Promise<SessionClaims> {
  guardCredentialAttempt(input.ip, "totp", session.userId);
  const user = await currentUser(db, session);
  if (user.totpEnabledAt) throw new HttpError(409, "El segundo factor ya está activo.", "totp_already_enabled");
  if (!user.totpSecret) throw new HttpError(400, "Primero generá el código para tu app autenticadora.", "totp_not_setup");
  if (consumeTotp(decrypt(user.totpSecret), input.code) !== "ok") {
    recordCredentialFailure(input.ip, "totp", session.userId);
    throw invalidCode();
  }
  const sessionEpoch = await withTenant(db, session.businessId, async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ totpEnabledAt: new Date(), sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
      .returning({ sessionEpoch: users.sessionEpoch });
    if (!row) throw new HttpError(409, "El segundo factor ya está activo.", "totp_already_enabled");
    await recordAudit(tx, session.businessId, "totp_enabled", userActor(user.id));
    return row.sessionEpoch;
  });
  return { businessId: session.businessId, userId: user.id, sessionEpoch };
}

export async function disableTotp(
  db: Executor,
  session: Session,
  input: { password: string; code: string; ip: string },
): Promise<SessionClaims> {
  guardCredentialAttempt(input.ip, "totp", session.userId);
  const user = await currentUser(db, session);
  if (!user.totpEnabledAt) throw new HttpError(409, "El segundo factor no está activo.", "totp_not_enabled");
  const passwordOk = await verifyPassword(input.password, user.passwordHash ?? DUMMY_HASH);
  if (!passwordOk) {
    recordCredentialFailure(input.ip, "totp", session.userId);
    throw invalidPassword();
  }
  if (!verifyUserTotp(user, input.code)) {
    recordCredentialFailure(input.ip, "totp", session.userId);
    throw invalidCode();
  }
  const sessionEpoch = await withTenant(db, session.businessId, async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(eq(users.id, user.id))
      .returning({ sessionEpoch: users.sessionEpoch });
    await recordAudit(tx, session.businessId, "totp_disabled", userActor(user.id));
    return row.sessionEpoch;
  });
  return { businessId: session.businessId, userId: user.id, sessionEpoch };
}
