import { and, asc, eq, inArray } from "drizzle-orm";
import { isRole, type Role, type SessionClaims } from "../../platform/auth/sessionToken";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getBusinessContext } from "../business";
import { bumpSessionEpoch } from "./identity";
import { membershipLocations, memberships, users } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// El equipo de un negocio: lista de miembros y cambios de rol, estado y sucursales.
// Todo con el contexto del negocio (`withTenant`): un negocio no ve ni toca la membresía
// de otro, y de `users` solo ve a quienes son miembros suyos.
//
// Reglas:
//   • Solo un dueño gestiona dueños (cambiar a un dueño o nombrar uno nuevo).
//   • Siempre queda al menos un dueño activo: el negocio no puede quedar sin nadie que
//     administre el equipo. El chequeo bloquea las filas de los dueños (FOR UPDATE, en
//     orden de id) para que dos dueños que se bajan a la vez no dejen cero.
//   • Cambiar rol o estado sube el epoch de esa persona: sus sesiones abiertas (en todos
//     sus negocios: el epoch es de la cuenta) se cierran y vuelve a entrar con lo nuevo.
//     Las sucursales no lo necesitan: la sesión las lee de la base en cada request.
// ─────────────────────────────────────────────────────────────────────────────

/** "invited": tiene membresía pero todavía no eligió su clave (no aceptó la invitación). */
export type MemberStatus = "active" | "invited" | "inactive";

export interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  status: MemberStatus;
  /** true = entra a todas las sucursales (dueño, o sin sucursales asignadas). */
  allLocations: boolean;
  /** Sucursales asignadas (vacío si `allLocations`). */
  locationIds: string[];
  totpEnabled: boolean;
  createdAt: string;
}

/** Valida que las sucursales sean del negocio (fuera de cualquier transacción: lee el caché). */
export async function assertLocationsOfBusiness(db: Executor, businessId: string, locationIds: readonly string[]): Promise<void> {
  if (locationIds.length === 0) return;
  const ctx = await getBusinessContext(db, businessId);
  const known = new Set(ctx?.locations.map((l) => l.id) ?? []);
  const unknown = locationIds.filter((id) => !known.has(id.toLowerCase()));
  if (unknown.length > 0) throw new ValidationError({ "body.locationIds": "Alguna de las sucursales no existe en este negocio." });
}

/**
 * ¿Algún miembro está limitado a esta sucursal? (filas en membership_locations). Lo usa
 * business al borrar una sucursal: si la borrara, ese miembro quedaría sin filas, que
 * significa "todas las sucursales"; en ese caso se desactiva en vez de borrarse.
 */
/**
 * Epoch vigente de cada persona de `userIds` que hoy puede entrar al negocio (cuenta
 * activa y membresía activa en ESE negocio). Las que no, no aparecen. Sirve para
 * comprobar que algo atado a una sesión (p. ej. una suscripción de notificaciones push)
 * sigue valiendo: si el epoch cambió (clave, rol o estado), ya no.
 */
export async function activeMemberSessionEpochs(
  executor: Executor,
  businessId: string,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ userId: users.id, sessionEpoch: users.sessionEpoch })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.businessId, businessId),
          inArray(memberships.userId, ids),
          eq(memberships.active, true),
          eq(users.active, true),
        ),
      ),
  );
  return new Map(rows.map((r) => [r.userId, r.sessionEpoch]));
}

export async function isLocationAssigned(executor: Executor, businessId: string, locationId: string): Promise<boolean> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: membershipLocations.membershipId })
      .from(membershipLocations)
      .where(and(eq(membershipLocations.businessId, businessId), eq(membershipLocations.locationId, locationId)))
      .limit(1),
  );
  return rows.length > 0;
}

/** Reemplaza las sucursales de una membresía (un dueño no lleva filas: entra a todas). */
export async function replaceMembershipLocations(
  tx: Tx,
  input: { membershipId: string; businessId: string; role: Role; locationIds: readonly string[] },
): Promise<void> {
  await tx.delete(membershipLocations).where(eq(membershipLocations.membershipId, input.membershipId));
  const ids = [...new Set(input.locationIds.map((id) => id.toLowerCase()))];
  if (input.role === "owner" || ids.length === 0) return;
  await tx
    .insert(membershipLocations)
    .values(ids.map((locationId) => ({ membershipId: input.membershipId, locationId, businessId: input.businessId })));
}

/** Miembros del negocio leídos con `tx` (contexto del negocio o de sistema). */
export async function readMembers(tx: Tx, businessId: string, membershipIds?: readonly string[]): Promise<Member[]> {
  const where = membershipIds
    ? and(eq(memberships.businessId, businessId), inArray(memberships.id, [...membershipIds]))
    : eq(memberships.businessId, businessId);
  const rows = await tx
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      active: memberships.active,
      createdAt: memberships.createdAt,
      hasPassword: users.passwordHash,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where)
    .orderBy(asc(memberships.createdAt));
  if (rows.length === 0) return [];
  const locs = await tx
    .select({ membershipId: membershipLocations.membershipId, locationId: membershipLocations.locationId })
    .from(membershipLocations)
    .where(and(eq(membershipLocations.businessId, businessId), inArray(membershipLocations.membershipId, rows.map((r) => r.membershipId))));
  const byMembership = new Map<string, string[]>();
  for (const l of locs) byMembership.set(l.membershipId, [...(byMembership.get(l.membershipId) ?? []), l.locationId]);

  return rows
    .filter((r) => isRole(r.role))
    .map((r): Member => {
      const locationIds = r.role === "owner" ? [] : (byMembership.get(r.membershipId) ?? []);
      return {
        membershipId: r.membershipId,
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: r.role as Role,
        active: r.active,
        status: !r.active ? "inactive" : r.hasPassword === null ? "invited" : "active",
        allLocations: locationIds.length === 0,
        locationIds,
        totpEnabled: r.totpEnabledAt !== null,
        createdAt: r.createdAt.toISOString(),
      };
    });
}

export function listMembers(db: Executor, businessId: string): Promise<Member[]> {
  return withTenant(db, businessId, (tx) => readMembers(tx, businessId));
}

export interface MemberPatch {
  role?: Role;
  active?: boolean;
  locationIds?: string[];
}

export interface MemberUpdate {
  member: Member;
  /** Claims para re-emitir la cookie si la persona se cambió a sí misma y sigue adentro. */
  reissue: SessionClaims | null;
}

const notFound = () => new HttpError(404, "Esa persona no es parte del equipo.", "not_found");

export async function updateMember(db: Executor, session: Session, membershipId: string, patch: MemberPatch): Promise<MemberUpdate> {
  const { businessId } = session;
  if (patch.locationIds) await assertLocationsOfBusiness(db, businessId, patch.locationIds);

  const result = await withTenant(db, businessId, async (tx) => {
    // Primero los dueños activos (en orden de id, para que dos cambios simultáneos tomen
    // los locks en el mismo orden y no se trancen), después la fila a cambiar.
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.role, "owner"), eq(memberships.active, true)))
      .orderBy(asc(memberships.id))
      .for("update");
    const [current] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)))
      .for("update");
    if (!current || !isRole(current.role)) throw notFound();

    const nextRole = patch.role ?? current.role;
    const nextActive = patch.active ?? current.active;
    if ((current.role === "owner" || nextRole === "owner") && session.role !== "owner") {
      throw new HttpError(403, "Solo un dueño puede cambiar a otro dueño o nombrar dueños.", "forbidden_role");
    }
    const losesOwner = current.role === "owner" && current.active && (nextRole !== "owner" || !nextActive);
    if (losesOwner && !owners.some((o) => o.id !== current.id)) {
      throw new HttpError(409, "Debe quedar al menos un dueño activo en el negocio.", "last_owner");
    }

    const roleOrStateChanged = nextRole !== current.role || nextActive !== current.active;
    if (roleOrStateChanged) {
      await tx.update(memberships).set({ role: nextRole, active: nextActive }).where(eq(memberships.id, current.id));
    }
    if (patch.locationIds !== undefined || (nextRole === "owner" && current.role !== "owner")) {
      await replaceMembershipLocations(tx, {
        membershipId: current.id,
        businessId,
        role: nextRole,
        locationIds: patch.locationIds ?? [],
      });
    }
    const newEpoch = roleOrStateChanged ? await bumpSessionEpoch(tx, current.userId) : null;
    await recordAudit(tx, businessId, "member_updated", userActor(session.userId), {
      membershipId: current.id,
      ...(patch.role !== undefined ? { role: nextRole } : {}),
      ...(patch.active !== undefined ? { active: nextActive } : {}),
      ...(patch.locationIds !== undefined ? { locationCount: new Set(patch.locationIds).size } : {}),
    });
    const [member] = await readMembers(tx, businessId, [current.id]);
    return { member, userId: current.userId, newEpoch, nextActive };
  });

  const reissue =
    result.userId === session.userId && result.newEpoch !== null && result.nextActive
      ? { businessId, userId: session.userId, sessionEpoch: result.newEpoch }
      : null;
  return { member: result.member, reissue };
}
