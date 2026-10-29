import { and, eq, sql } from "drizzle-orm";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../../platform/auth/password";
import { isRole, type Role, type SessionClaims } from "../../platform/auth/sessionToken";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withSystem, type Executor } from "../../platform/db/scope";
import { queueEmail } from "../../platform/email/enqueue";
import { invitationEmail } from "../../platform/email/templates";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { publicUrl } from "../../platform/http/publicUrl";
import { assertQuota } from "../../platform/plan/planHooks";
import { getBusinessContext } from "../business";
import { verifyUserTotp } from "./auth";
import { guardCredentialAttempt, NewPasswordSchema, normalizeEmail, recordCredentialFailure } from "./identity";
import { countActiveMembersIn, readMembers, replaceMembershipLocations, type Member } from "./members";
import { memberships, users, type AuthToken, type User } from "./schema";
import { consumeToken, findValidToken, INVITATION_TTL_MS, issueAuthToken } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Invitaciones al equipo (PLAN-GESTION.md §2: cada profesional entra con su usuario).
//
// Invitar crea (si no existe) el usuario SIN clave, su membresía ACTIVA con el rol y las
// sucursales, y un token de 7 días que va por correo (todo en una transacción con el
// correo encolado: outbox). Mientras no elija su clave, el miembro figura como
// "invited" y no puede entrar (el login compara contra DUMMY_HASH).
//
// Aceptar (con la sesión iniciada al final):
//   • cuenta nueva → elige nombre y clave;
//   • cuenta que ya existe (está en otro negocio) → confirma con SU clave actual (y su
//     código si tiene 2FA): el link de la invitación nunca sirve para cambiarle la clave
//     a nadie ni para saltarse su segundo factor.
//
// Reenviar la invitación a alguien que todavía no la aceptó es invitarlo de nuevo: se
// actualizan rol y sucursales y solo vale el último link.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta del panel que abre el link del correo (con `?token=`). */
export const ACCEPT_INVITATION_PATH = "/panel/accept-invitation";

export interface InviteInput {
  business: { id: string; name: string; brandColor?: string | null };
  email: string;
  name?: string | null;
  role: Role;
  /** Sucursales (ya validadas contra el negocio); se ignoran para un dueño. */
  locationIds?: readonly string[];
  /** Nombre de quien invita (null = la plataforma). */
  invitedByName: string | null;
  /** Actor del rastro de auditoría ("user:<id>" o "superadmin:<usuario>"). */
  actor: string;
  /**
   * Cupo de usuarios del plan (membresías activas; lo resuelve la ruta antes de la
   * transacción). Sin valor = sin tope (p. ej. el dueño que invita el superadmin al dar
   * de alta el negocio).
   */
  userLimit?: number | null;
}

/**
 * Invita a una persona al negocio. Si `executor` es una transacción abierta (alta de un
 * negocio por el superadmin), todo queda dentro de ella. No lee nada con el pool: todo
 * lo que necesita del negocio viene en `input.business`.
 */
export async function inviteMember(executor: Executor, input: InviteInput): Promise<Member> {
  const email = normalizeEmail(input.email);
  const businessId = input.business.id;
  return withSystem(executor, async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email, name: input.name?.trim() || email.split("@")[0] })
        .returning();
    } else if (!user.active) {
      throw new HttpError(409, "Esa cuenta está desactivada en la plataforma.", "user_inactive");
    }

    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, user.id)))
      .limit(1);
    if (existing && user.passwordHash !== null) {
      throw new HttpError(409, "Esa persona ya es parte del equipo.", "already_member");
    }
    // Una invitación nueva (o reenviar una que se había desactivado) ocupa un lugar más.
    await assertQuota(tx, {
      businessId,
      resource: "users",
      limit: input.userLimit,
      count: () => countActiveMembersIn(tx, businessId),
      adding: existing?.active ? 0 : 1,
    });
    let membershipId: string;
    if (existing) {
      // Reenvío a alguien que todavía no aceptó: rol y estado nuevos, solo vale el último link.
      await tx.update(memberships).set({ role: input.role, active: true }).where(eq(memberships.id, existing.id));
      if (input.name?.trim()) await tx.update(users).set({ name: input.name.trim() }).where(eq(users.id, user.id));
      membershipId = existing.id;
    } else {
      const [created] = await tx
        .insert(memberships)
        .values({ businessId, userId: user.id, role: input.role })
        .returning({ id: memberships.id });
      membershipId = created.id;
    }
    await replaceMembershipLocations(tx, { membershipId, businessId, role: input.role, locationIds: input.locationIds ?? [] });

    const { token } = await issueAuthToken(tx, { userId: user.id, kind: "invitation", businessId });
    const content = invitationEmail({
      businessName: input.business.name,
      brandColor: input.business.brandColor,
      inviteeName: input.name?.trim() || (user.passwordHash === null ? null : user.name),
      invitedByName: input.invitedByName,
      acceptUrl: publicUrl(ACCEPT_INVITATION_PATH, { token }),
      expiresInMinutes: INVITATION_TTL_MS / 60_000,
    });
    await queueEmail(tx, { to: user.email, ...content, tags: { kind: "invitation" } }, { businessId });
    await recordAudit(tx, businessId, "member_invited", input.actor, { membershipId, role: input.role });

    const [member] = await readMembers(tx, businessId, [membershipId]);
    return member;
  });
}

const invalidInvitation = (status: 400 | 404) =>
  new HttpError(status, "La invitación no es válida o venció. Pedile a quien te invitó que te la mande de nuevo.", "invalid_token");

interface PendingInvitation {
  token: AuthToken;
  user: User;
  businessId: string;
  businessName: string;
  role: Role;
}

/** Invitación vigente con su persona, membresía activa y negocio activo; null si algo no está. */
async function findInvitation(db: Executor, token: string): Promise<PendingInvitation | null> {
  const found = await withSystem(db, async (tx) => {
    const row = await findValidToken(tx, token, "invitation");
    if (!row || !row.businessId) return null;
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
    const [membership] = await tx
      .select({ role: memberships.role, active: memberships.active })
      .from(memberships)
      .where(and(eq(memberships.businessId, row.businessId), eq(memberships.userId, row.userId)))
      .limit(1);
    if (!user || !user.active || !membership || !membership.active || !isRole(membership.role)) return null;
    return { token: row, user, businessId: row.businessId, role: membership.role };
  });
  if (!found) return null;
  const ctx = await getBusinessContext(db, found.businessId);
  if (!ctx || ctx.business.status !== "active") return null;
  return { ...found, businessName: ctx.business.name };
}

export interface InvitationInfo {
  email: string;
  businessName: string;
  role: Role;
  /** true = la persona ya tiene cuenta (entra con su clave actual, sin elegir otra). */
  hasAccount: boolean;
}

export async function getInvitation(db: Executor, token: string): Promise<InvitationInfo> {
  const inv = await findInvitation(db, token);
  if (!inv) throw invalidInvitation(404);
  return { email: inv.user.email, businessName: inv.businessName, role: inv.role, hasAccount: inv.user.passwordHash !== null };
}

/** Acepta la invitación y devuelve los claims de la sesión en ese negocio. */
export async function acceptInvitation(
  db: Executor,
  input: { token: string; name?: string; password: string; totpCode?: string; ip: string },
): Promise<SessionClaims> {
  const inv = await findInvitation(db, input.token);
  if (!inv) throw invalidInvitation(400);
  const { user } = inv;

  if (user.passwordHash === null) {
    // Cuenta nueva: elige nombre y clave (con las reglas de una clave nueva).
    const name = input.name?.trim() ?? "";
    const fields: Record<string, string> = {};
    if (!name) fields["body.name"] = "Campo obligatorio.";
    const passwordCheck = NewPasswordSchema.safeParse(input.password);
    if (!passwordCheck.success) fields["body.password"] = passwordCheck.error.issues[0].message;
    if (Object.keys(fields).length > 0) throw new ValidationError(fields);
    const passwordHash = await hashPassword(input.password);
    const sessionEpoch = await withSystem(db, async (tx) => {
      if (!(await consumeToken(tx, inv.token.id))) return null;
      const [row] = await tx
        .update(users)
        .set({ name, passwordHash, mustChangePassword: false, sessionEpoch: sql`${users.sessionEpoch} + 1` })
        .where(and(eq(users.id, user.id), sql`${users.passwordHash} IS NULL`))
        .returning({ sessionEpoch: users.sessionEpoch });
      if (!row) return null;
      await recordAudit(tx, inv.businessId, "invitation_accepted", userActor(user.id), { newAccount: true });
      return row.sessionEpoch;
    });
    if (sessionEpoch === null) throw invalidInvitation(400);
    return { businessId: inv.businessId, userId: user.id, sessionEpoch };
  }

  // Cuenta existente: confirma con su clave (y su 2FA). Nunca se le cambia la clave acá.
  guardCredentialAttempt(input.ip, "invitation", user.id);
  if (!(await verifyPassword(input.password, user.passwordHash ?? DUMMY_HASH))) {
    recordCredentialFailure(input.ip, "invitation", user.id);
    throw new HttpError(400, "La clave no es correcta: usá la clave con la que ya entrás.", "invalid_password");
  }
  if (user.totpEnabledAt) {
    if (!input.totpCode?.trim()) {
      throw new HttpError(400, "Tu cuenta tiene segundo factor: ingresá el código de tu app autenticadora.", "totp_required");
    }
    if (!verifyUserTotp(user, input.totpCode.trim())) {
      recordCredentialFailure(input.ip, "invitation", user.id);
      throw new HttpError(400, "El código no es correcto.", "invalid_code");
    }
  }
  const consumed = await withSystem(db, async (tx) => {
    if (!(await consumeToken(tx, inv.token.id))) return false;
    await recordAudit(tx, inv.businessId, "invitation_accepted", userActor(user.id), { newAccount: false });
    return true;
  });
  if (!consumed) throw invalidInvitation(400);
  return { businessId: inv.businessId, userId: user.id, sessionEpoch: user.sessionEpoch };
}
