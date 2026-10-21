import { and, asc, count, eq, inArray, max, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { hasPgCode, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from "../../platform/db/errors";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { assertLocationAccess, assertSameIds } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { assertQuota } from "../../platform/plan/planHooks";
import {
  assertLocationsOfBusiness,
  fromDbTime,
  overlappingBlocks,
  sortBlocks,
  WeeklyHoursSchema,
  type WeeklyBlock,
} from "../business";
import { memberships, staff, staffHours, users, type Staff } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Profesionales (quienes atienden las citas): Configuración > Equipo y la API pública que
// usa la agenda para calcular disponibilidad sin leer las tablas de team.
//
//   • Un profesional puede existir sin usuario (el dueño carga a su equipo sin invitarlo)
//     y vincularse a una membresía del negocio cuando entra con el suyo (una membresía es
//     a lo sumo un profesional).
//   • Horario semanal POR SUCURSAL: el PUT reemplaza el horario de UNA sucursal y no puede
//     cruzarse con lo que la persona ya trabaja en otra el mismo día (no está en dos
//     lugares a la vez). No se exige que caiga dentro del horario de la sucursal: la
//     disponibilidad es la intersección de los dos.
//   • "Eliminar" borra solo a quien no tiene historial; con citas, comisiones o
//     liquidaciones (FKs NO ACTION) se desactiva.
//   • Cupo del plan (`staffLimit`, profesionales ACTIVOS): crear uno activo o reactivar a
//     uno inactivo pasando el tope → 403 `plan_limit_reached` (lo resuelve la ruta antes
//     de la transacción; null/undefined = sin tope).
// ─────────────────────────────────────────────────────────────────────────────

/** Profesional (API pública). */
export interface StaffMember {
  id: string;
  name: string;
  /** Color de su columna en la agenda ("#rrggbb"). */
  color: string | null;
  active: boolean;
  position: number;
  /** Membresía (usuario del panel) vinculada, o null. */
  membershipId: string | null;
}

/** Tramo del horario de un profesional en una sucursal (horas locales de la sucursal). */
export interface StaffWeeklyBlock extends WeeklyBlock {
  staffId: string;
  locationId: string;
}

/** Profesional como lo muestra Configuración > Equipo. */
export interface StaffView extends StaffMember {
  /** Nombre y correo del usuario vinculado (si hay). */
  member: { name: string; email: string } | null;
  /** Horario de todas sus sucursales, por sucursal, día y hora. */
  hours: StaffWeeklyBlock[];
}

export type DeleteStaffResult = { deleted: true } | { deleted: false; staff: StaffView };

/** Colores por defecto de las columnas de la agenda (se asignan en orden). */
export const STAFF_COLORS = ["#0b7d72", "#6a8ee8", "#e86a92", "#e0902f", "#8a63d2", "#5cb88a", "#c7513b", "#3aa0c8"] as const;

const notFound = () => new HttpError(404, "Ese profesional no existe.", "not_found");

function toMember(s: Staff): StaffMember {
  return { id: s.id, name: s.name, color: s.color, active: s.active, position: s.position, membershipId: s.membershipId };
}

// ── Validación ──────────────────────────────────────────────────────────────

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color inválido (formato #rrggbb).");

const StaffFields = z.object({
  name: z.string().trim().min(1).max(120),
  color: HexColor.nullable(),
  active: z.boolean(),
  membershipId: z.uuid().nullable(),
});

export const NewStaffInput = StaffFields.partial({ color: true, active: true, membershipId: true }).strict();

export const StaffPatch = StaffFields.partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const StaffHoursInput = z.object({ locationId: z.uuid(), hours: WeeklyHoursSchema }).strict();

export const StaffOrderInput = z.object({ ids: z.array(z.uuid()).max(500) }).strict();

// ── Lectura ─────────────────────────────────────────────────────────────────

function hoursOf(rows: readonly (typeof staffHours.$inferSelect)[]): StaffWeeklyBlock[] {
  const blocks = rows.map((h) => ({
    staffId: h.staffId,
    locationId: h.locationId,
    weekday: h.weekday,
    start: fromDbTime(h.startsAt),
    end: fromDbTime(h.endsAt),
  }));
  return sortBlocks(blocks).sort((a, b) => (a.locationId === b.locationId ? 0 : a.locationId < b.locationId ? -1 : 1));
}

async function readStaffViews(tx: Tx, businessId: string, staffIds?: readonly string[]): Promise<StaffView[]> {
  const where = staffIds ? and(eq(staff.businessId, businessId), inArray(staff.id, [...staffIds])) : eq(staff.businessId, businessId);
  const rows = await tx
    .select({ staff, memberName: users.name, memberEmail: users.email })
    .from(staff)
    .leftJoin(memberships, eq(memberships.id, staff.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(where)
    .orderBy(asc(staff.position), asc(staff.createdAt));
  if (rows.length === 0) return [];
  const hours = await tx
    .select()
    .from(staffHours)
    .where(and(eq(staffHours.businessId, businessId), inArray(staffHours.staffId, rows.map((r) => r.staff.id))));
  return rows.map((r) => ({
    ...toMember(r.staff),
    member: r.memberName !== null && r.memberEmail !== null ? { name: r.memberName, email: r.memberEmail } : null,
    hours: hoursOf(hours.filter((h) => h.staffId === r.staff.id)),
  }));
}

async function readStaffView(tx: Tx, businessId: string, staffId: string): Promise<StaffView> {
  const [view] = await readStaffViews(tx, businessId, [staffId]);
  if (!view) throw notFound();
  return view;
}

/** Profesionales activos del negocio, contados con `tx` (cupo del plan). */
async function countActiveStaffIn(tx: Tx, businessId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(staff)
    .where(and(eq(staff.businessId, businessId), eq(staff.active, true)));
  return Number(row?.n ?? 0);
}

/** Profesionales activos del negocio (uso del plan). */
export function countActiveStaff(executor: Executor, businessId: string): Promise<number> {
  return withTenant(executor, businessId, (tx) => countActiveStaffIn(tx, businessId));
}

/** Equipo completo (activos e inactivos) en el orden de la agenda. */
export function listStaffViews(db: Executor, businessId: string): Promise<StaffView[]> {
  return withTenant(db, businessId, (tx) => readStaffViews(tx, businessId));
}

// ── API pública (agenda, agente, catálogo) ──────────────────────────────────

/**
 * Profesionales del negocio en el orden de la agenda. `activeOnly` deja solo los
 * activos; `locationId` deja solo los que tienen horario en esa sucursal.
 */
export async function listStaff(
  executor: Executor,
  businessId: string,
  options: { activeOnly?: boolean; locationId?: string } = {},
): Promise<StaffMember[]> {
  return withTenant(executor, businessId, async (tx) => {
    const conditions: SQL[] = [eq(staff.businessId, businessId)];
    if (options.activeOnly) conditions.push(eq(staff.active, true));
    if (options.locationId) {
      const withHours = tx
        .selectDistinct({ id: staffHours.staffId })
        .from(staffHours)
        .where(and(eq(staffHours.businessId, businessId), eq(staffHours.locationId, options.locationId)));
      conditions.push(inArray(staff.id, withHours));
    }
    const rows = await tx
      .select()
      .from(staff)
      .where(and(...conditions))
      .orderBy(asc(staff.position), asc(staff.createdAt));
    return rows.map(toMember);
  });
}

/** Un profesional del negocio, o null. */
export async function getStaffMember(executor: Executor, businessId: string, staffId: string): Promise<StaffMember | null> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)))
      .limit(1),
  );
  return row ? toMember(row) : null;
}

/**
 * Horario semanal de los profesionales (horas locales de cada sucursal), filtrado por
 * profesional y/o sucursal. No filtra por activo: combinalo con `listStaff`.
 */
export async function getStaffWeeklyHours(
  executor: Executor,
  businessId: string,
  filter: { staffId?: string; locationId?: string } = {},
): Promise<StaffWeeklyBlock[]> {
  const conditions: SQL[] = [eq(staffHours.businessId, businessId)];
  if (filter.staffId) conditions.push(eq(staffHours.staffId, filter.staffId));
  if (filter.locationId) conditions.push(eq(staffHours.locationId, filter.locationId));
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(staffHours)
      .where(and(...conditions)),
  );
  return hoursOf(rows);
}

// ── Escritura ───────────────────────────────────────────────────────────────

async function snapshot(tx: Tx, session: Session, entity: string, view: StaffView | Record<string, unknown>, entityId: string): Promise<void> {
  await recordConfigChange(tx, { businessId: session.businessId, entity, entityId, snapshot: view, changedBy: session.userId });
}

/** La membresía tiene que ser del negocio; y no estar vinculada a otro profesional. */
async function assertLinkableMembership(tx: Tx, businessId: string, membershipId: string, staffId?: string): Promise<void> {
  const [membership] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)))
    .limit(1);
  if (!membership) throw new ValidationError({ "body.membershipId": "Ese usuario no es parte del equipo." });
  const conditions = [eq(staff.businessId, businessId), eq(staff.membershipId, membershipId)];
  if (staffId) conditions.push(ne(staff.id, staffId));
  const [taken] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(and(...conditions))
    .limit(1);
  if (taken) throw membershipTaken();
}

const membershipTaken = () => new HttpError(409, "Ese usuario ya está vinculado a otro profesional.", "membership_taken");

export async function createStaff(
  db: Executor,
  session: Session,
  input: z.output<typeof NewStaffInput>,
  staffLimit?: number | null,
): Promise<StaffView> {
  const { businessId } = session;
  try {
    return await withTenant(db, businessId, async (tx) => {
      if (input.active ?? true) {
        await assertQuota(tx, { businessId, resource: "staff", limit: staffLimit, count: () => countActiveStaffIn(tx, businessId) });
      }
      if (input.membershipId) await assertLinkableMembership(tx, businessId, input.membershipId);
      const [{ last }] = await tx
        .select({ last: max(staff.position) })
        .from(staff)
        .where(eq(staff.businessId, businessId));
      const position = (last ?? -1) + 1;
      const [row] = await tx
        .insert(staff)
        .values({
          businessId,
          name: input.name,
          color: input.color ?? STAFF_COLORS[position % STAFF_COLORS.length],
          active: input.active ?? true,
          membershipId: input.membershipId ?? null,
          position,
        })
        .returning({ id: staff.id });
      const view = await readStaffView(tx, businessId, row.id);
      await snapshot(tx, session, "staff", view, view.id);
      return view;
    });
  } catch (error) {
    if (hasPgCode(error, PG_UNIQUE_VIOLATION)) throw membershipTaken();
    throw error;
  }
}

export async function updateStaff(
  db: Executor,
  session: Session,
  staffId: string,
  patch: z.output<typeof StaffPatch>,
  staffLimit?: number | null,
): Promise<StaffView> {
  const { businessId } = session;
  try {
    return await withTenant(db, businessId, async (tx) => {
      if (patch.active === true) {
        // Reactivar a alguien inactivo suma un activo: cuenta para el cupo del plan.
        const [current] = await tx
          .select({ active: staff.active })
          .from(staff)
          .where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)))
          .for("update");
        if (current && !current.active) {
          await assertQuota(tx, { businessId, resource: "staff", limit: staffLimit, count: () => countActiveStaffIn(tx, businessId) });
        }
      }
      if (patch.membershipId) await assertLinkableMembership(tx, businessId, patch.membershipId, staffId);
      const [row] = await tx
        .update(staff)
        .set(patch)
        .where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)))
        .returning({ id: staff.id });
      if (!row) throw notFound();
      const view = await readStaffView(tx, businessId, staffId);
      await snapshot(tx, session, "staff", view, view.id);
      return view;
    });
  } catch (error) {
    if (hasPgCode(error, PG_UNIQUE_VIOLATION)) throw membershipTaken();
    throw error;
  }
}

/**
 * Reemplaza el horario del profesional en UNA sucursal. Rechaza (400) un tramo que se
 * cruce con lo que ya trabaja en otra sucursal ese mismo día.
 */
export async function replaceStaffHours(
  db: Executor,
  session: Session,
  staffId: string,
  input: { locationId: string; hours: readonly WeeklyBlock[] },
): Promise<StaffView> {
  const { businessId } = session;
  const locationId = input.locationId.toLowerCase();
  assertLocationAccess(session, locationId);
  await assertLocationsOfBusiness(db, businessId, [locationId], "body.locationId");
  return withTenant(db, businessId, async (tx) => {
    const [row] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)))
      .for("update");
    if (!row) throw notFound();
    const elsewhere = await tx
      .select()
      .from(staffHours)
      .where(and(eq(staffHours.staffId, staffId), ne(staffHours.locationId, locationId)));
    const clashes = overlappingBlocks(input.hours, hoursOf(elsewhere));
    if (clashes.length > 0) {
      throw new ValidationError(
        Object.fromEntries(clashes.map((i) => [`body.hours.${i}.start`, "Se cruza con el horario de este profesional en otra sucursal."])),
      );
    }
    await tx.delete(staffHours).where(and(eq(staffHours.staffId, staffId), eq(staffHours.locationId, locationId)));
    if (input.hours.length > 0) {
      await tx.insert(staffHours).values(
        sortBlocks(input.hours).map((b) => ({ businessId, staffId, locationId, weekday: b.weekday, startsAt: b.start, endsAt: b.end })),
      );
    }
    const view = await readStaffView(tx, businessId, staffId);
    await snapshot(tx, session, "staff", view, view.id);
    return view;
  });
}

/** Nuevo orden de las columnas de la agenda: `ids` = todos los profesionales, en orden. */
export async function reorderStaff(db: Executor, session: Session, ids: readonly string[]): Promise<StaffView[]> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const current = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.businessId, businessId))
      .orderBy(asc(staff.id))
      .for("update");
    assertSameIds(
      current.map((r) => r.id),
      ids,
    );
    for (const [position, id] of ids.entries()) {
      await tx
        .update(staff)
        .set({ position })
        .where(and(eq(staff.id, id.toLowerCase()), eq(staff.businessId, businessId)));
    }
    await snapshot(tx, session, "staff_order", { ids: ids.map((id) => id.toLowerCase()) }, businessId);
    return readStaffViews(tx, businessId);
  });
}

/** Borra al profesional si no tiene historial; si lo tiene, lo desactiva. */
export async function deleteStaff(db: Executor, session: Session, staffId: string): Promise<DeleteStaffResult> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx): Promise<DeleteStaffResult> => {
    const current = await readStaffView(tx, businessId, staffId);
    try {
      // Savepoint: si una FK NO ACTION (citas, comisiones, liquidaciones) frena el
      // borrado, se deshace solo esto y se desactiva.
      await tx.transaction(async (sp) => {
        await sp.delete(staff).where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)));
      });
      await snapshot(tx, session, "staff", { ...current, deleted: true }, staffId);
      return { deleted: true };
    } catch (error) {
      if (!hasPgCode(error, PG_FOREIGN_KEY_VIOLATION)) throw error;
    }
    await tx
      .update(staff)
      .set({ active: false })
      .where(and(eq(staff.id, staffId), eq(staff.businessId, businessId)));
    const view = await readStaffView(tx, businessId, staffId);
    await snapshot(tx, session, "staff", view, staffId);
    return { deleted: false, staff: view };
  });
}
