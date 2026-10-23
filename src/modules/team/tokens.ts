import crypto from "node:crypto";
import { and, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { Tx } from "../../platform/db/scope";
import { authTokens, type AuthToken, type AuthTokenKind } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Tokens de un solo uso de los links por correo (tabla `auth_tokens`, solo de sistema:
// todas estas funciones esperan una transacción con `withSystem`).
//
//   • El token son 32 bytes al azar en base64url (256 bits: adivinarlo no es un ataque).
//   • En la base va solo su sha256: con un dump no se puede usar ningún link vigente.
//   • Emitir uno nuevo borra los anteriores del mismo tipo para esa persona (y ese
//     negocio, en las invitaciones): solo sirve el ÚLTIMO link que se mandó.
//   • Consumir es un UPDATE … WHERE used_at IS NULL: dos clics a la vez no lo usan dos veces.
// ─────────────────────────────────────────────────────────────────────────────

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
export const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000; // 2 días

const TTL_BY_KIND: Record<AuthTokenKind, number> = {
  password_reset: PASSWORD_RESET_TTL_MS,
  invitation: INVITATION_TTL_MS,
  email_verification: EMAIL_VERIFICATION_TTL_MS,
};

/** Forma de un token emitido acá (base64url de 32 bytes = 43 caracteres). */
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface IssuedToken {
  /** El token en claro: va en el link del correo y en ningún otro lado. */
  token: string;
  expiresAt: Date;
}

/** Emite un token nuevo (e invalida los anteriores del mismo tipo para esa persona/negocio). */
export async function issueAuthToken(
  tx: Tx,
  input: { userId: string; kind: AuthTokenKind; businessId?: string | null },
): Promise<IssuedToken> {
  const businessId = input.businessId ?? null;
  const sameScope: SQL[] = [eq(authTokens.userId, input.userId), eq(authTokens.kind, input.kind)];
  if (businessId) sameScope.push(eq(authTokens.businessId, businessId));
  await tx.delete(authTokens).where(and(...sameScope));

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_BY_KIND[input.kind]);
  await tx.insert(authTokens).values({ userId: input.userId, businessId, kind: input.kind, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

/** Token vigente (sin usar y sin vencer) del tipo pedido, o null. No lo consume. */
export async function findValidToken(tx: Tx, token: string, kind: AuthTokenKind): Promise<AuthToken | null> {
  if (!RE_TOKEN.test(token)) return null;
  const [row] = await tx
    .select()
    .from(authTokens)
    .where(
      and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())),
    )
    .limit(1);
  return row ?? null;
}

/** Marca el token como usado. false si otro request lo usó primero (o ya venció). */
export async function consumeToken(tx: Tx, id: string): Promise<boolean> {
  const used = await tx
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, id), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .returning({ id: authTokens.id });
  return used.length === 1;
}
