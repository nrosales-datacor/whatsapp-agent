import { eq } from "drizzle-orm";
import { hashPassword } from "../../platform/auth/password";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withSystem, type Executor } from "../../platform/db/scope";
import { queueEmail } from "../../platform/email/enqueue";
import { passwordResetEmail } from "../../platform/email/templates";
import { HttpError } from "../../platform/http/errors";
import { publicBaseUrl, publicUrl } from "../../platform/http/publicUrl";
import { setPassword } from "./auth";
import { markEmailVerified } from "./emailVerification";
import { guardCredentialAttempt, normalizeEmail, recordCredentialFailure } from "./identity";
import { users } from "./schema";
import { consumeToken, findValidToken, issueAuthToken, PASSWORD_RESET_TTL_MS } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Recuperación de clave por correo (PLAN-GESTION.md §2, "Acceso fácil").
//
//   1. /auth/password/forgot: responde 204 SIEMPRE (exista o no la cuenta). Si existe y
//      está activa, emite un token de 1 h y encola el correo en la MISMA transacción
//      (outbox: si algo falla, ni token ni correo).
//   2. /auth/password/reset: consume el token (una sola vez), fija la clave nueva y sube
//      el epoch: si alguien más tenía una sesión abierta con la clave vieja, se le cierra.
//
// Anti-bombardeo: cada pedido cuenta como un "fallo" del par (IP, email) en el rate
// limit, así que pedir muchas veces el correo de la misma cuenta desde el mismo lugar
// termina en lockout progresivo (429), igual para cuentas reales e inventadas.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta del panel que abre el link del correo (con `?token=`). */
export const RESET_PASSWORD_PATH = "/panel/reset-password";

const invalidToken = () => new HttpError(400, "El enlace no es válido o venció. Pedí uno nuevo.", "invalid_token");

export async function requestPasswordReset(db: Executor, input: { email: string; ip: string }): Promise<void> {
  const email = normalizeEmail(input.email);
  guardCredentialAttempt(input.ip, "forgot", email);
  recordCredentialFailure(input.ip, "forgot", email);
  // La base de los links se resuelve ANTES de buscar la cuenta: si falta PUBLIC_BASE_URL
  // en producción, falla igual para todos los emails (un 500 solo para los que existen
  // sería un oráculo de qué cuentas hay).
  publicBaseUrl();

  await withSystem(db, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, name: users.name, active: users.active })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user || !user.active) return;
    const { token } = await issueAuthToken(tx, { userId: user.id, kind: "password_reset" });
    const content = passwordResetEmail({
      userName: user.name,
      resetUrl: publicUrl(RESET_PASSWORD_PATH, { token }),
      expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
    });
    await queueEmail(tx, { to: user.email, ...content, tags: { kind: "password_reset" } });
  });
}

export async function resetPassword(db: Executor, input: { token: string; password: string }): Promise<void> {
  // Primero el chequeo barato del token; scrypt solo para un token vigente (un anónimo no
  // puede hacerle gastar CPU al proceso con tokens inventados).
  const pending = await withSystem(db, (tx) => findValidToken(tx, input.token, "password_reset"));
  if (!pending) throw invalidToken();
  const passwordHash = await hashPassword(input.password);

  const ok = await withSystem(db, async (tx) => {
    if (!(await consumeToken(tx, pending.id))) return false;
    const [user] = await tx.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, pending.userId)).limit(1);
    if (!user || !user.active) return false;
    await setPassword(tx, user.id, passwordHash);
    // El enlace llegó a su correo: también lo verifica (alta self-service sin confirmar).
    await markEmailVerified(tx, user.id);
    await recordAudit(tx, null, "password_reset", userActor(user.id));
    return true;
  });
  if (!ok) throw invalidToken();
}
