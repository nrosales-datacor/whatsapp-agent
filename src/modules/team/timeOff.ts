import { and, asc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { assertAllLocationsAccess, assertLocationAccess } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { assertLocationsOfBusiness } from "../business";
import { staff, timeOff, type TimeOff } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Ausencias y cierres (`time_off`): feriados del negocio, cierres de una sucursal y
// vacaciones o incapacidades de un profesional, en una sola tabla (PLAN-GESTION.md §4).
//
//   • Alcance: sin sucursal ni profesional → todo el negocio; solo sucursal → esa
//     sucursal; con profesional → esa persona (en todas sus sucursales, o en una si trae
//     sucursal).
//   • Instantes (timestamptz, ISO 8601 con zona): el panel convierte lo que la persona
//     escribe en la zona de la sucursal o del negocio. [starts_at, ends_at).
//   • Lo que no es de una sola sucursal (feriado del negocio, ausencia de alguien en todas
//     sus sucursales) lo carga quien tiene acceso a todas.
// ─────────────────────────────────────────────────────────────────────────────

export type TimeOffScope = "business" | "location" | "staff";

/** Ausencia o cierre (API pública). En JSON, las fechas salen como ISO 8601. */
export interface TimeOffEntry {
  id: string;
  scope: TimeOffScope;
  locationId: string | null;
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function scopeOf(row: Pick<TimeOff, "staffId" | "locationId">): TimeOffScope {
  if (row.staffId) return "staff";
  return row.locationId ? "location" : "business";
}

function toEntry(row: TimeOff): TimeOffEntry {
  return {
    id: row.id,
    scope: scopeOf(row),
    locationId: row.locationId,
    staffId: row.staffId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    reason: row.reason,
  };
}

const notFound = () => new HttpError(404, "Esa ausencia no existe.", "not_found");

// ── Validación ──────────────────────────────────────────────────────────────

const Instant = z.iso.datetime({ offset: true, error: "Fecha y hora inválidas (ISO 8601 con zona)." }).transform((s) => new Date(s));

const TimeOffFields = z.object({
  locationId: z.uuid().nullable(),
  staffId: z.uuid().nullable(),
  startsAt: Instant,
  endsAt: Instant,
  reason: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((s) => (s ? s : null)),
});

/** Problema del rango [startsAt, endsAt), o null si está bien. */
function rangeError(startsAt: Date, endsAt: Date): string | null {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (ms <= 0) return "El fin tiene que ser después del inicio.";
  if (ms > MAX_RANGE_MS) return "Una ausencia dura como máximo un año.";
  return null;
}

export const NewTimeOffInput = TimeOffFields.partial({ locationId: true, staffId: true, reason: true })
  .strict()
  .superRefine((input, ctx) => {
    // Si una fecha ya falló su propia validación, no hay rango que revisar.
    if (!(input.startsAt instanceof Date) || !(input.endsAt instanceof Date)) return;
    const problem = rangeError(input.startsAt, input.endsAt);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["endsAt"] });
  });

export const TimeOffPatch = TimeOffFields.partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const TimeOffQuery = z
  .object({
    from: Instant.optional(),
    to: Instant.optional(),
    locationId: z.uuid().optional(),
    staffId: z.uuid().optional(),
  })
  .strict();

// ── API pública (agenda, agente) ────────────────────────────────────────────

/**
 * Ausencias y cierres que se cruzan con [from, to) y que AFECTAN al alcance pedido:
 *   • siempre los del negocio entero;
 *   • los de una sucursal, si es `locationId` (o sin filtro de sucursal);
 *   • los de un profesional, si es `staffId` (o sin filtro de profesional) y su sucursal
 *     es `locationId` o ninguna (= ausente en todas sus sucursales).
 * Ordenadas por inicio.
 */
export async function listTimeOff(
  executor: Executor,
  businessId: string,
  filter: { from: Date; to: Date; locationId?: string; staffId?: string },
): Promise<TimeOffEntry[]> {
  const conditions: SQL[] = [eq(timeOff.businessId, businessId), lt(timeOff.startsAt, filter.to), gt(timeOff.endsAt, filter.from)];
  const locationOk = filter.locationId ? or(isNull(timeOff.locationId), eq(timeOff.locationId, filter.locationId)) : undefined;
  const staffOk = filter.staffId ? or(isNull(timeOff.staffId), eq(timeOff.staffId, filter.staffId)) : undefined;
  if (locationOk) conditions.push(locationOk);
  if (staffOk) conditions.push(staffOk);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(timeOff)
      .where(and(...conditions))
      .orderBy(asc(timeOff.startsAt), asc(timeOff.createdAt)),
  );
  return rows.map(toEntry);
}

// ── Escritura ───────────────────────────────────────────────────────────────

interface Target {
  locationId: string | null;
  staffId: string | null;
}

/** Sucursal y profesional del negocio, y que la sesión pueda cargar ese alcance. */
async function assertTarget(tx: Tx, session: Session, target: Target): Promise<void> {
  if (target.locationId) {
    assertLocationAccess(session, target.locationId);
    await assertLocationsOfBusiness(tx, session.businessId, [target.locationId], "body.locationId");
  } else {
    assertAllLocationsAccess(session);
  }
  if (target.staffId) {
    const [row] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, target.staffId), eq(staff.businessId, session.businessId)))
      .limit(1);
    if (!row) throw new ValidationError({ "body.staffId": "Ese profesional no existe en este negocio." });
  }
}

async function snapshot(tx: Tx, session: Session, entry: TimeOffEntry | Record<string, unknown>, id: string): Promise<void> {
  await recordConfigChange(tx, { businessId: session.businessId, entity: "time_off", entityId: id, snapshot: entry, changedBy: session.userId });
}

export async function createTimeOff(db: Executor, session: Session, input: z.output<typeof NewTimeOffInput>): Promise<TimeOffEntry> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const target = { locationId: input.locationId?.toLowerCase() ?? null, staffId: input.staffId?.toLowerCase() ?? null };
    await assertTarget(tx, session, target);
    const [row] = await tx
      .insert(timeOff)
      .values({ businessId, ...target, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason ?? null })
      .returning();
    const entry = toEntry(row);
    await snapshot(tx, session, entry, entry.id);
    return entry;
  });
}

async function lockEntry(tx: Tx, session: Session, id: string): Promise<TimeOff> {
  const [row] = await tx
    .select()
    .from(timeOff)
    .where(and(eq(timeOff.id, id), eq(timeOff.businessId, session.businessId)))
    .for("update");
  if (!row) throw notFound();
  // Quien no entra a la sucursal de la ausencia (o a todas, si es de todo el negocio) no la toca.
  if (row.locationId) assertLocationAccess(session, row.locationId);
  else assertAllLocationsAccess(session);
  return row;
}

export async function updateTimeOff(db: Executor, session: Session, id: string, patch: z.output<typeof TimeOffPatch>): Promise<TimeOffEntry> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const current = await lockEntry(tx, session, id);
    const next = {
      locationId: patch.locationId !== undefined ? (patch.locationId?.toLowerCase() ?? null) : current.locationId,
      staffId: patch.staffId !== undefined ? (patch.staffId?.toLowerCase() ?? null) : current.staffId,
      startsAt: patch.startsAt ?? current.startsAt,
      endsAt: patch.endsAt ?? current.endsAt,
      reason: patch.reason !== undefined ? patch.reason : current.reason,
    };
    const problem = rangeError(next.startsAt, next.endsAt);
    if (problem) throw new ValidationError({ "body.endsAt": problem });
    if (patch.locationId !== undefined || patch.staffId !== undefined) await assertTarget(tx, session, next);
    const [row] = await tx.update(timeOff).set(next).where(eq(timeOff.id, current.id)).returning();
    const entry = toEntry(row);
    await snapshot(tx, session, entry, entry.id);
    return entry;
  });
}

export async function deleteTimeOff(db: Executor, session: Session, id: string): Promise<void> {
  await withTenant(db, session.businessId, async (tx) => {
    const current = await lockEntry(tx, session, id);
    await tx.delete(timeOff).where(eq(timeOff.id, current.id));
    await snapshot(tx, session, { ...toEntry(current), deleted: true }, current.id);
  });
}
