import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { SessionClaims } from "../../platform/auth/sessionToken";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withSystem, type Executor, type Tx } from "../../platform/db/scope";
import { queueEmail } from "../../platform/email/enqueue";
import { emailVerificationEmail } from "../../platform/email/templates";
import { HttpError } from "../../platform/http/errors";
import { publicUrl } from "../../platform/http/publicUrl";
import { getBusinessContext } from "../business";
import { normalizeEmail } from "./identity";
import { memberships, users } from "./schema";
import { consumeToken, EMAIL_VERIFICATION_TTL_MS, findValidToken, issueAuthToken } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Verificación del correo del alta self-service (I6). La dueña nace con
// `email_unverified_since` y NO entra al panel (ni login ni sesión) hasta abrir el enlace
// de un solo uso que le llega por correo (vence en 2 días; reenviar invalida el anterior).
// Abrirlo verifica el correo y deja la sesión iniciada: el clic ya prueba que el correo es
// suyo. Restablecer la clave o aceptar una invitación también lo prueban (ver recovery e
// invitations).
//
// Por qué bloquear en vez de "uso limitado hasta verificar": el panel manda correos y
// WhatsApp a nombre del negocio (invitaciones, recordatorios) y la cuenta es el contacto
// de cobro y de recuperación. Una cuenta con un correo ajeno o inventado no puede usarse
// para nada, y el costo es un clic que además inicia la sesión.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta del panel que abre el link del correo (con `?token=`). */
export const VERIFY_EMAIL_PATH = "/panel/verify-email";

const invalidVerification = () =>
  new HttpError(400, "El enlace no es válido o venció. Pedí uno nuevo desde la pantalla de ingreso.", "invalid_token");

/** Cuenta de un correo (para el alta: no revelar nada, solo decidir qué correo mandar). */
export interface AccountByEmail {
  userId: string;
  name: string;
  email: string;
  active: boolean;
  /** Correo sin verificar (alta self-service pendiente). */
  unverified: boolean;
}

export async function findAccountByEmail(executor: Executor, email: string): Promise<AccountByEmail | null> {
  const [row] = await withSystem(executor, (tx) =>
    tx
      .select({ userId: users.id, name: users.name, email: users.email, active: users.active, unverifiedSince: users.emailUnverifiedSince })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1),
  );
  if (!row) return null;
  return { userId: row.userId, name: row.name, email: row.email, active: row.active, unverified: row.unverifiedSince !== null };
}

/**
 * Crea la dueña del alta self-service (cuenta con clave y correo SIN verificar + membresía
 * de dueña) dentro de la transacción del llamador (la del alta del negocio). El correo no
 * tiene que existir: si existe, el índice único corta la transacción entera.
 */
export async function createUnverifiedOwner(
  tx: Tx,
  input: { businessId: string; email: string; name: string; passwordHash: string; now?: Date },
): Promise<{ userId: string }> {
  return withSystem(tx, async (stx) => {
    const [user] = await stx
      .insert(users)
      .values({ email: normalizeEmail(input.email), name: input.name.trim(), passwordHash: input.passwordHash, emailUnverifiedSince: input.now ?? new Date() })
      .returning({ id: users.id });
    await stx.insert(memberships).values({ businessId: input.businessId, userId: user.id, role: "owner" });
    return { userId: user.id };
  });
}

/** Emite el enlace (invalida el anterior) y encola el correo, en la transacción del llamador. */
export async function sendEmailVerification(
  tx: Tx,
  input: { userId: string; email: string; name: string | null; businessId: string; businessName: string; trialDays?: number | null },
): Promise<void> {
  await withSystem(tx, async (stx) => {
    const { token } = await issueAuthToken(stx, { userId: input.userId, kind: "email_verification", businessId: input.businessId });
    const content = emailVerificationEmail({
      userName: input.name,
      businessName: input.businessName,
      verifyUrl: publicUrl(VERIFY_EMAIL_PATH, { token }),
      expiresInMinutes: EMAIL_VERIFICATION_TTL_MS / 60_000,
      trialDays: input.trialDays,
    });
    await queueEmail(stx, { to: input.email, ...content, tags: { kind: "email_verification" } }, { businessId: input.businessId });
  });
}

/**
 * Reenvía el enlace a una cuenta con el correo sin verificar (y su negocio del alta). No
 * hace nada (sin error) si la cuenta no existe, ya está verificada o está desactivada: la
 * respuesta de la API es siempre la misma.
 */
export async function resendEmailVerification(db: Executor, email: string, options: { trialDays?: number | null } = {}): Promise<boolean> {
  const account = await findAccountByEmail(db, email);
  if (!account || !account.active || !account.unverified) return false;
  const [membership] = await withSystem(db, (tx) =>
    tx
      .select({ businessId: memberships.businessId })
      .from(memberships)
      .where(and(eq(memberships.userId, account.userId), eq(memberships.role, "owner"), eq(memberships.active, true)))
      .orderBy(asc(memberships.createdAt))
      .limit(1),
  );
  if (!membership) return false;
  const ctx = await getBusinessContext(db, membership.businessId);
  if (!ctx || ctx.business.status !== "active") return false;
  await withSystem(db, (tx) =>
    sendEmailVerification(tx, {
      userId: account.userId,
      email: account.email,
      name: account.name,
      businessId: ctx.business.id,
      businessName: ctx.business.name,
      trialDays: options.trialDays,
    }),
  );
  return true;
}

/** Marca el correo como verificado (restablecer la clave o aceptar una invitación también lo prueban). */
export async function markEmailVerified(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ emailUnverifiedSince: null })
    .where(and(eq(users.id, userId), isNotNull(users.emailUnverifiedSince)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Consume el enlace, verifica el correo y devuelve los claims de la sesión en el negocio
 * del alta. `onVerified` corre DENTRO de la misma transacción (el alta arranca ahí la
 * prueba): o queda todo, o nada y el enlace sigue sin usar.
 */
export async function verifyEmailToken(
  db: Executor,
  token: string,
  onVerified?: (tx: Tx, input: { userId: string; businessId: string }) => Promise<void>,
): Promise<SessionClaims> {
  const claims = await withSystem(db, async (tx): Promise<SessionClaims | null> => {
    const row = await findValidToken(tx, token, "email_verification");
    if (!row || !row.businessId) return null;
    if (!(await consumeToken(tx, row.id))) return null;
    const [user] = await tx
      .update(users)
      .set({ emailUnverifiedSince: null })
      .where(and(eq(users.id, row.userId), eq(users.active, true)))
      .returning({ id: users.id, sessionEpoch: users.sessionEpoch });
    if (!user) return null;
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.businessId, row.businessId), eq(memberships.userId, user.id), eq(memberships.active, true)))
      .limit(1);
    if (!membership) return null;
    await onVerified?.(tx, { userId: user.id, businessId: row.businessId });
    await recordAudit(tx, row.businessId, "email_verified", userActor(user.id));
    return { businessId: row.businessId, userId: user.id, sessionEpoch: user.sessionEpoch };
  });
  if (!claims) throw invalidVerification();
  return claims;
}

/** ¿Quedan cuentas sin verificar de este negocio? (diagnóstico y tests). */
export async function hasUnverifiedOwner(db: Executor, businessId: string): Promise<boolean> {
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.businessId, businessId), isNotNull(users.emailUnverifiedSince)))
      .limit(1),
  );
  return rows.length > 0;
}
