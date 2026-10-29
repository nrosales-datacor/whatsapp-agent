import { and, eq } from "drizzle-orm";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withSystem, type Executor, type Tx } from "../../platform/db/scope";
import { queueEmail } from "../../platform/email/enqueue";
import { emailVerificationEmail, signupAttemptEmail } from "../../platform/email/templates";
import { HttpError } from "../../platform/http/errors";
import { publicBaseUrl, publicUrl } from "../../platform/http/publicUrl";
import { guardCredentialAttempt, normalizeEmail, recordCredentialFailure } from "./identity";
import { memberships, users } from "./schema";
import { consumeToken, EMAIL_VERIFICATION_TTL_MS, findValidToken, issueAuthToken } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Cuenta del alta self-service (I6.7) y verificación de su correo.
//
//   • `createSelfServiceOwner` (dentro de la transacción del alta, con `withSystem`): la
//     cuenta con su clave y la marca `email_verification_pending`, su membresía de dueña y
//     el correo con el link de 48 h (outbox: o queda todo o nada).
//   • Mientras no confirme, el login con la clave correcta responde 403
//     `email_not_verified` (./auth.ts). El link de verificación la apaga; también la apagan
//     restablecer la clave y aceptar una invitación (los dos links llegan a ese correo).
//   • Reenviar el link responde 204 siempre (exista o no la cuenta, esté o no verificada):
//     no es un oráculo de cuentas. Cuenta como "fallo" en el rate limit, como pedir el
//     correo de recuperación: pedirlo muchas veces termina en 429.
//   • Registrarse con un correo que ya tiene cuenta no crea nada y le avisa por correo a la
//     cuenta existente (`noticeExistingAccount`): la respuesta del registro es la misma.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta del panel que abre el link del correo (con `?token=`). */
export const VERIFY_EMAIL_PATH = "/panel/verify-email";
const LOGIN_PATH = "/panel/login";
const FORGOT_PASSWORD_PATH = "/panel/forgot-password";

const invalidToken = () => new HttpError(400, "El enlace no es válido o venció. Pedí uno nuevo desde la pantalla de entrada.", "invalid_token");

/** 403 del login de una cuenta que todavía no confirmó su correo. */
export const emailNotVerified = () =>
  new HttpError(403, "Todavía no confirmaste tu correo. Buscá el enlace que te mandamos (o pedí uno nuevo) y volvé a entrar.", "email_not_verified");

export interface SelfServiceOwnerInput {
  businessId: string;
  businessName: string;
  /** Ya normalizado y sin cuenta (lo chequea el alta dentro de la misma transacción). */
  email: string;
  name: string;
  passwordHash: string;
}

async function queueVerificationEmail(tx: Tx, user: { id: string; email: string; name: string }, businessName: string | null): Promise<void> {
  const { token } = await issueAuthToken(tx, { userId: user.id, kind: "email_verification" });
  const content = emailVerificationEmail({
    userName: user.name,
    businessName,
    verifyUrl: publicUrl(VERIFY_EMAIL_PATH, { token }),
    expiresInMinutes: EMAIL_VERIFICATION_TTL_MS / 60_000,
  });
  await queueEmail(tx, { to: user.email, ...content, tags: { kind: "email_verification" } });
}

/** La cuenta dueña del negocio recién creado, sin verificar, y el correo con el link. Devuelve su id. */
export async function createSelfServiceOwner(tx: Tx, input: SelfServiceOwnerInput): Promise<string> {
  const [user] = await tx
    .insert(users)
    .values({ email: normalizeEmail(input.email), name: input.name.trim(), passwordHash: input.passwordHash, emailVerificationPending: true })
    .returning({ id: users.id, email: users.email, name: users.name });
  await tx.insert(memberships).values({ businessId: input.businessId, userId: user.id, role: "owner" });
  await queueVerificationEmail(tx, user, input.businessName);
  return user.id;
}

/** ¿Hay una cuenta con este correo? (dentro de la transacción del alta, contexto de sistema). */
export async function emailHasAccount(tx: Tx, email: string): Promise<{ id: string; name: string; email: string; active: boolean } | null> {
  const [user] = await tx
    .select({ id: users.id, name: users.name, email: users.email, active: users.active })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return user ?? null;
}

/** Aviso a la cuenta que ya existe: alguien quiso registrarse con su correo. */
export async function noticeExistingAccount(tx: Tx, user: { email: string; name: string }): Promise<void> {
  const content = signupAttemptEmail({ userName: user.name, loginUrl: publicUrl(LOGIN_PATH), forgotUrl: publicUrl(FORGOT_PASSWORD_PATH) });
  await queueEmail(tx, { to: user.email, ...content, tags: { kind: "signup_attempt" } });
}

/** Confirma el correo con el token del link (una sola vez). */
export async function verifyEmail(db: Executor, token: string): Promise<void> {
  const ok = await withSystem(db, async (tx) => {
    const pending = await findValidToken(tx, token, "email_verification");
    if (!pending || !(await consumeToken(tx, pending.id))) return false;
    const updated = await tx
      .update(users)
      .set({ emailVerificationPending: false })
      .where(and(eq(users.id, pending.userId), eq(users.active, true)))
      .returning({ id: users.id });
    if (updated.length === 0) return false;
    await recordAudit(tx, null, "email_verified", userActor(pending.userId));
    return true;
  });
  if (!ok) throw invalidToken();
}

/** Reenvía el link de verificación. Responde igual exista o no la cuenta (ver cabecera). */
export async function resendEmailVerification(db: Executor, input: { email: string; ip: string }): Promise<void> {
  const email = normalizeEmail(input.email);
  guardCredentialAttempt(input.ip, "verify", email);
  recordCredentialFailure(input.ip, "verify", email);
  // La base de los links se resuelve antes de buscar la cuenta (mismo criterio que la recuperación de clave).
  publicBaseUrl();
  await withSystem(db, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, name: users.name, active: users.active, pending: users.emailVerificationPending })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user || !user.active || !user.pending) return;
    await queueVerificationEmail(tx, user, null);
  });
}
