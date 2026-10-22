import { and, asc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { hasPgCode, PG_FOREIGN_KEY_VIOLATION } from "../../platform/db/errors";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { assertAllLocationsAccess, assertLocationAccess, hasLocationAccess } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { assertQuota } from "../../platform/plan/planHooks";
import { getBusinessContext, invalidateBusinessContext, type LocationWithHours } from "./context";
import { fromDbTime, sortBlocks, WeeklyHoursSchema, type WeeklyBlock } from "./hours";
import { DEFAULT_LOCATION_HOURS, isValidTimeZone } from "./provisioning";
import { businesses, locationHours, locations, type Location, type LocationHour } from "./schema";
import { countActiveLocations } from "./subscription";

// ─────────────────────────────────────────────────────────────────────────────
// Sucursales y su horario semanal: Configuración > Sucursales y la API pública que usa
// la agenda (disponibilidad) y el agente.
//
//   • Siempre queda al menos UNA sucursal activa.
//   • "Eliminar" borra solo una sucursal sin historial. Con historial (citas, pagos, un
//     número de WhatsApp: FKs NO ACTION que la base hace cumplir) o con algo de otro
//     módulo que depende de que exista (`LocationReferenceCheck`), se DESACTIVA: deja de
//     aparecer en la agenda y en el agente, y los reportes la conservan.
//   • Cada cambio: snapshot en config_history (misma transacción) e invalidación del
//     caché del contexto al confirmar.
//   • Una sesión limitada a algunas sucursales solo edita esas, y no crea sucursales.
//   • Cupo del plan (`locationLimit`, sucursales ACTIVAS): crear una o reactivar una
//     desactivada pasando el tope → 403 `plan_limit_reached`. El cupo lo resuelve la ruta
//     antes de la transacción (src/platform/plan/planHooks.ts); null/undefined = sin tope.
// ─────────────────────────────────────────────────────────────────────────────

/** Sucursal tal como la ven la API y la API pública. */
export interface LocationView {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  /** Zona IANA: el horario y la agenda de la sucursal se leen en esta zona. */
  timezone: string;
  active: boolean;
  position: number;
  /** Horario semanal ordenado por día y hora (vacío = cerrada toda la semana). */
  hours: WeeklyBlock[];
}

/**
 * ¿Algo de OTRO módulo depende de que esta sucursal exista? (p. ej. un miembro del equipo
 * limitado a ella, o un servicio que se ofrece solo ahí: borrarla dejaría a esas filas
 * sin sucursal, que en el modelo significa "todas"). La inyecta la composición
 * (src/routes.ts): business no importa team ni catalog. true → se desactiva en vez de
 * borrarse.
 */
export type LocationReferenceCheck = (executor: Executor, businessId: string, locationId: string) => Promise<boolean>;

export type DeleteLocationResult = { deleted: true } | { deleted: false; location: LocationView };

function blockOf(h: Pick<LocationHour, "weekday" | "opensAt" | "closesAt">): WeeklyBlock {
  return { weekday: h.weekday, start: fromDbTime(h.opensAt), end: fromDbTime(h.closesAt) };
}

function toView(location: Location, hours: readonly Pick<LocationHour, "weekday" | "opensAt" | "closesAt">[]): LocationView {
  return {
    id: location.id,
    name: location.name,
    address: location.address,
    phone: location.phone,
    timezone: location.timezone,
    active: location.active,
    position: location.position,
    hours: sortBlocks(hours.map(blockOf)),
  };
}

function fromContext(l: LocationWithHours): LocationView {
  return toView(l, l.hours);
}

const notFound = () => new HttpError(404, "Esa sucursal no existe.", "not_found");
const lastLocation = () =>
  new HttpError(409, "El negocio tiene que tener al menos una sucursal activa.", "last_location");

// ── Validación ──────────────────────────────────────────────────────────────

const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

const LocationFields = z.object({
  name: z.string().trim().min(1).max(120),
  address: OptionalText(300),
  phone: OptionalText(40),
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria inválida (ej. America/Costa_Rica)."),
});

export const NewLocationInput = LocationFields.extend({
  address: OptionalText(300).optional(),
  phone: OptionalText(40).optional(),
  // Sin zona: la del negocio.
  timezone: LocationFields.shape.timezone.optional(),
  // Sin horario: el default (lunes a viernes 8–18 y sábado 8–12).
  hours: WeeklyHoursSchema.optional(),
}).strict();

export const LocationPatch = LocationFields.extend({ active: z.boolean() })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const LocationHoursInput = z.object({ hours: WeeklyHoursSchema }).strict();

// ── Lectura ─────────────────────────────────────────────────────────────────

async function readLocation(tx: Tx, businessId: string, locationId: string): Promise<LocationView | null> {
  const [location] = await tx
    .select()
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
    .limit(1);
  if (!location) return null;
  const hours = await tx.select().from(locationHours).where(eq(locationHours.locationId, location.id));
  return toView(location, hours);
}

/**
 * Sucursales del negocio en su orden (desde el caché del contexto). Una sesión limitada a
 * algunas sucursales ve solo esas.
 */
export async function listLocationsForSession(db: Executor, session: Session): Promise<LocationView[]> {
  const ctx = await getBusinessContext(db, session.businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx.locations.filter((l) => hasLocationAccess(session, l.id)).map(fromContext);
}

// ── API pública (agenda, agente) ────────────────────────────────────────────

/**
 * Sucursales del negocio en su orden, con su horario. Lee del caché del contexto (TTL
 * corto, ver ./context.ts): pasale la base, no una transacción que esté cambiando la
 * configuración.
 */
export async function listLocations(
  executor: Executor,
  businessId: string,
  options: { activeOnly?: boolean } = {},
): Promise<LocationView[]> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) return [];
  return ctx.locations.filter((l) => !options.activeOnly || l.active).map(fromContext);
}

/** Una sucursal del negocio con su horario (del caché del contexto), o null. */
export async function getLocation(executor: Executor, businessId: string, locationId: string): Promise<LocationView | null> {
  const ctx = await getBusinessContext(executor, businessId);
  const location = ctx?.locations.find((l) => l.id === locationId.toLowerCase());
  return location ? fromContext(location) : null;
}

/**
 * Horario semanal de atención de una sucursal ([] si no existe o cierra toda la semana).
 * Horas locales de `location.timezone`. La disponibilidad de un profesional es la
 * intersección de esto con su propio horario en la sucursal (`getStaffWeeklyHours` de
 * team) menos las ausencias (`listTimeOff`).
 */
export async function getLocationWeeklyHours(executor: Executor, businessId: string, locationId: string): Promise<WeeklyBlock[]> {
  return (await getLocation(executor, businessId, locationId))?.hours ?? [];
}

/**
 * Valida que las sucursales sean del negocio, leyendo la base (no el caché: una sucursal
 * recién creada en otro proceso tiene que valer). 400 con el error en `field` si alguna no.
 * Las FKs no alcanzan: un chequeo de FK no pasa por RLS y aceptaría la sucursal de otro
 * negocio.
 */
export async function assertLocationsOfBusiness(
  executor: Executor,
  businessId: string,
  locationIds: readonly string[],
  field = "body.locationIds",
): Promise<void> {
  const ids = [...new Set(locationIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.businessId, businessId), inArray(locations.id, ids))),
  );
  if (rows.length !== ids.length) throw new ValidationError({ [field]: "Alguna de las sucursales no existe en este negocio." });
}

// ── Escritura ───────────────────────────────────────────────────────────────

async function snapshot(tx: Tx, session: Session, location: LocationView): Promise<void> {
  await recordConfigChange(tx, {
    businessId: session.businessId,
    entity: "location",
    entityId: location.id,
    snapshot: location,
    changedBy: session.userId,
  });
}

async function replaceHours(tx: Tx, businessId: string, locationId: string, blocks: readonly WeeklyBlock[]): Promise<void> {
  await tx.delete(locationHours).where(eq(locationHours.locationId, locationId));
  if (blocks.length === 0) return;
  await tx
    .insert(locationHours)
    .values(sortBlocks(blocks).map((b) => ({ businessId, locationId, weekday: b.weekday, opensAt: b.start, closesAt: b.end })));
}

/** Bloquea las sucursales activas del negocio (en orden de id) y dice cuántas hay. */
async function lockActiveLocations(tx: Tx, businessId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.businessId, businessId), eq(locations.active, true)))
    .orderBy(asc(locations.id))
    .for("update");
  return rows.map((r) => r.id);
}

export async function createLocation(
  db: Executor,
  session: Session,
  input: z.output<typeof NewLocationInput>,
  locationLimit?: number | null,
): Promise<LocationView> {
  assertAllLocationsAccess(session);
  const { businessId } = session;
  const view = await withTenant(db, businessId, async (tx) => {
    await assertQuota(tx, { businessId, resource: "locations", limit: locationLimit, count: () => countActiveLocations(tx, businessId) });
    const [business] = await tx.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId));
    if (!business) throw new HttpError(404, "Negocio no encontrado.", "not_found");
    const [{ last }] = await tx
      .select({ last: max(locations.position) })
      .from(locations)
      .where(eq(locations.businessId, businessId));
    const [location] = await tx
      .insert(locations)
      .values({
        businessId,
        name: input.name,
        address: input.address ?? null,
        phone: input.phone ?? null,
        timezone: input.timezone ?? business.timezone,
        position: (last ?? -1) + 1,
      })
      .returning();
    const blocks = input.hours ?? DEFAULT_LOCATION_HOURS.map((h) => ({ weekday: h.weekday, start: h.opensAt, end: h.closesAt }));
    await replaceHours(tx, businessId, location.id, blocks);
    const created = await readLocation(tx, businessId, location.id);
    if (!created) throw notFound();
    await snapshot(tx, session, created);
    return created;
  });
  invalidateBusinessContext(businessId);
  return view;
}

export async function updateLocation(
  db: Executor,
  session: Session,
  locationId: string,
  patch: z.output<typeof LocationPatch>,
  locationLimit?: number | null,
): Promise<LocationView> {
  assertLocationAccess(session, locationId);
  const { businessId } = session;
  const view = await withTenant(db, businessId, async (tx) => {
    if (patch.active === false) {
      const active = await lockActiveLocations(tx, businessId);
      if (active.length === 1 && active[0] === locationId.toLowerCase()) throw lastLocation();
    }
    if (patch.active === true) {
      // Reactivar una desactivada suma una activa: cuenta para el cupo del plan.
      const [current] = await tx
        .select({ active: locations.active })
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
        .for("update");
      if (current && !current.active) {
        await assertQuota(tx, { businessId, resource: "locations", limit: locationLimit, count: () => countActiveLocations(tx, businessId) });
      }
    }
    const [row] = await tx
      .update(locations)
      .set(patch)
      .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
      .returning({ id: locations.id });
    if (!row) throw notFound();
    const updated = await readLocation(tx, businessId, locationId);
    if (!updated) throw notFound();
    await snapshot(tx, session, updated);
    return updated;
  });
  invalidateBusinessContext(businessId);
  return view;
}

export async function replaceLocationHours(db: Executor, session: Session, locationId: string, blocks: readonly WeeklyBlock[]): Promise<LocationView> {
  assertLocationAccess(session, locationId);
  const { businessId } = session;
  const view = await withTenant(db, businessId, async (tx) => {
    const [row] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
      .for("update");
    if (!row) throw notFound();
    await replaceHours(tx, businessId, locationId, blocks);
    const updated = await readLocation(tx, businessId, locationId);
    if (!updated) throw notFound();
    await snapshot(tx, session, updated);
    return updated;
  });
  invalidateBusinessContext(businessId);
  return view;
}

/**
 * Borra la sucursal si no tiene historial; si lo tiene (o `isReferenced` dice que otro
 * módulo depende de ella), la desactiva. Nunca deja al negocio sin sucursales activas.
 */
export async function deleteLocation(
  db: Executor,
  session: Session,
  locationId: string,
  isReferenced: LocationReferenceCheck,
): Promise<DeleteLocationResult> {
  assertLocationAccess(session, locationId);
  const { businessId } = session;
  const id = locationId.toLowerCase();
  const result = await withTenant(db, businessId, async (tx): Promise<DeleteLocationResult> => {
    const active = await lockActiveLocations(tx, businessId);
    const current = await readLocation(tx, businessId, id);
    if (!current) throw notFound();
    if (current.active && active.length === 1 && active[0] === id) throw lastLocation();

    let deleted = false;
    if (!(await isReferenced(tx, businessId, id))) {
      try {
        // Savepoint: si una FK NO ACTION (citas, pagos, canal de WhatsApp) frena el
        // borrado, se deshace solo esto y la transacción sigue para desactivarla.
        await tx.transaction(async (sp) => {
          await sp.delete(locations).where(and(eq(locations.id, id), eq(locations.businessId, businessId)));
        });
        deleted = true;
      } catch (error) {
        if (!hasPgCode(error, PG_FOREIGN_KEY_VIOLATION)) throw error;
      }
    }
    if (deleted) {
      await recordConfigChange(tx, {
        businessId,
        entity: "location",
        entityId: id,
        snapshot: { ...current, deleted: true },
        changedBy: session.userId,
      });
      return { deleted: true };
    }
    await tx
      .update(locations)
      .set({ active: false })
      .where(and(eq(locations.id, id), eq(locations.businessId, businessId)));
    const deactivated = await readLocation(tx, businessId, id);
    if (!deactivated) throw notFound();
    await snapshot(tx, session, deactivated);
    return { deleted: false, location: deactivated };
  });
  invalidateBusinessContext(businessId);
  return result;
}
