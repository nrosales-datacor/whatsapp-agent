import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { checkLoginLimit, recordLoginAttempt, recordLoginFailure } from "../../platform/auth/loginRateLimit";
import { isRole, type Role } from "../../platform/auth/sessionToken";
import { withSystem, type Executor, type Tx } from "../../platform/db/scope";
import { tooManyAttempts } from "../../platform/http/errors";
import { getBusinessContext } from "../business";
import { memberships, users, type User } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Piezas comunes de la identidad (login, sesión, recuperación, invitaciones): reglas de la
// clave, normalización del email, búsquedas de usuarios y membresías, y el epoch.
//
// Usuarios y membresías de VARIOS negocios (login, "¿en qué negocios está?") se leen con
// `withSystem`: la persona es de la plataforma, no de un negocio. Lo que es de UN negocio
// (la sesión de cada request, la lista del equipo) se lee con `withTenant`.
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 8;
// Tope por costo: scrypt sobre un texto enorme es CPU gratis para un atacante.
export const MAX_PASSWORD_LENGTH = 200;

/** Clave nueva (registro, cambio, recuperación). */
export const NewPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `La clave tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`)
  .max(MAX_PASSWORD_LENGTH, `La clave puede tener como máximo ${MAX_PASSWORD_LENGTH} caracteres.`);

/** Clave que se verifica (login, confirmar una acción): sin reglas de forma, solo un tope. */
export const PasswordInputSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);

/** Código TOTP tal como lo tipea la persona (con espacios o no); lo valida `consumeTotp`. */
export const TotpCodeSchema = z.string().trim().max(16);

/** El email se guarda y se compara siempre en minúsculas y sin espacios (CHECK de `users`). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(executor: Executor, email: string): Promise<User | null> {
  const [user] = await withSystem(executor, (tx) => tx.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1));
  return user ?? null;
}

export async function findUserById(executor: Executor, userId: string): Promise<User | null> {
  const [user] = await withSystem(executor, (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
  return user ?? null;
}

/** Membresía activa de una persona en un negocio ACTIVO. */
export interface ActiveMembership {
  membershipId: string;
  businessId: string;
  businessName: string;
  role: Role;
}

/**
 * Membresías activas de la persona en negocios activos (un negocio pausado o dado de baja
 * no aparece), en el orden en que se sumó a cada uno.
 */
export async function activeMemberships(executor: Executor, userId: string): Promise<ActiveMembership[]> {
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({ id: memberships.id, businessId: memberships.businessId, role: memberships.role, active: memberships.active })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt)),
  );
  const out: ActiveMembership[] = [];
  for (const m of rows) {
    if (!m.active || !isRole(m.role)) continue;
    const ctx = await getBusinessContext(executor, m.businessId);
    if (!ctx || ctx.business.status !== "active") continue;
    out.push({ membershipId: m.id, businessId: m.businessId, businessName: ctx.business.name, role: m.role });
  }
  return out;
}

/**
 * Sube el epoch de la cuenta: TODAS sus sesiones (en todos sus negocios y dispositivos)
 * dejan de valer en la request siguiente. Corre con el contexto de `tx` (sistema, o el
 * negocio del que la persona es miembro). Devuelve el epoch nuevo.
 */
export async function bumpSessionEpoch(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionEpoch: users.sessionEpoch });
  if (!row) throw new Error("bumpSessionEpoch: el usuario no existe o no es visible en este contexto");
  return row.sessionEpoch;
}

/**
 * Ámbitos del rate limit de credenciales (src/platform/auth/loginRateLimit.ts): cada uno
 * con su propio lockout por (IP, clave), para que fallar el código del 2FA no bloquee el
 * login ni al revés. El límite por IP sí es uno solo: es el presupuesto de CPU (scrypt)
 * que una IP le puede hacer gastar al proceso.
 */
export type CredentialScope = "login" | "forgot" | "password" | "totp" | "invitation";

/**
 * Chequea el rate limit ANTES de gastar scrypt (o de verificar un código) y cuenta el
 * intento contra la IP. Lanza 429 `too_many_attempts` si se pasó.
 */
export function guardCredentialAttempt(ip: string, scope: CredentialScope, key: string): void {
  const limit = checkLoginLimit(ip, scope, key);
  if (!limit.allowed) throw tooManyAttempts(limit.retryAfterSec);
  recordLoginAttempt(ip);
}

/** Intento fallido (clave o código incorrecto): suma al lockout progresivo. */
export function recordCredentialFailure(ip: string, scope: CredentialScope, key: string): void {
  recordLoginFailure(ip, scope, key);
}
