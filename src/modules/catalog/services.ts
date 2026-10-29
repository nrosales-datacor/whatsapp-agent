import { and, asc, eq, inArray, isNull, max, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { assertSameIds } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { assertLocationsOfBusiness } from "../business";
import { serviceCategories, serviceLocations, services, type Service, type ServiceCategory } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo: categorías y servicios (Configuración > Servicios) y la API pública que usan
// la agenda y el agente.
//
//   • Montos en CÉNTIMOS de la moneda del negocio (`priceCents`). Con `variablePrice` es
//     el precio "desde" (se cotiza según el caso). 0 = sin precio cargado.
//   • `bufferMin`: limpieza / preparación DESPUÉS del servicio. Ocupa al profesional pero
//     no se le muestra al cliente como parte de la cita.
//   • Sucursales donde se ofrece: `locationIds` vacío = en todas.
//   • Orden: `position` dentro de su categoría (servicios) y entre categorías. Reordenar
//     manda la lista completa en el orden nuevo.
//   • Borrar un servicio lo borra: las líneas de las citas copian nombre, duración y
//     precio (el histórico no depende de que siga existiendo). Para dejar de ofrecerlo
//     sin perderlo, se desactiva. Borrar una categoría deja sus servicios sin categoría.
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryView {
  id: string;
  name: string;
  position: number;
}

/** Servicio (API pública y Configuración). */
export interface ServiceView {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  variablePrice: boolean;
  /** false = solo lo agenda el negocio (panel), no el agente ni la reserva web. */
  onlineBooking: boolean;
  active: boolean;
  position: number;
  /** Sucursales donde se ofrece; vacío = en todas. */
  locationIds: string[];
}

export interface CatalogView {
  categories: CategoryView[];
  /** Ordenados por categoría (en el orden de las categorías; sin categoría al final) y posición. */
  services: ServiceView[];
}

const categoryNotFound = () => new HttpError(404, "Esa categoría no existe.", "not_found");
const serviceNotFound = () => new HttpError(404, "Ese servicio no existe.", "not_found");

function toCategory(c: ServiceCategory): CategoryView {
  return { id: c.id, name: c.name, position: c.position };
}

function toService(s: Service, locationIds: string[]): ServiceView {
  return {
    id: s.id,
    categoryId: s.categoryId,
    name: s.name,
    description: s.description,
    durationMin: s.durationMin,
    bufferMin: s.bufferMin,
    priceCents: s.priceCents,
    variablePrice: s.variablePrice,
    onlineBooking: s.onlineBooking,
    active: s.active,
    position: s.position,
    locationIds,
  };
}

// ── Validación ──────────────────────────────────────────────────────────────

/** Tope de un monto en céntimos (mil millones de unidades): entra holgado en un bigint y en un number exacto. */
export const MAX_PRICE_CENTS = 100_000_000_000;

export const PriceCents = z.int().min(0).max(MAX_PRICE_CENTS);
export const DurationMin = z
  .int()
  .min(5)
  .max(24 * 60)
  .multipleOf(5);
const BufferMin = z.int().min(0).max(240).multipleOf(5);

const ServiceFields = z.object({
  categoryId: z.uuid().nullable(),
  name: z.string().trim().min(1).max(120),
  description: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .transform((s) => (s ? s : null)),
  durationMin: DurationMin,
  bufferMin: BufferMin,
  priceCents: PriceCents,
  variablePrice: z.boolean(),
  onlineBooking: z.boolean(),
  active: z.boolean(),
  locationIds: z.array(z.uuid()).max(200),
});

export const NewServiceInput = ServiceFields.partial({
  categoryId: true,
  description: true,
  bufferMin: true,
  priceCents: true,
  variablePrice: true,
  onlineBooking: true,
  active: true,
  locationIds: true,
}).strict();

export const ServicePatch = ServiceFields.partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const CategoryInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export const CategoryOrderInput = z.object({ ids: z.array(z.uuid()).max(500) }).strict();

export const ServiceOrderInput = z.object({ categoryId: z.uuid().nullable(), ids: z.array(z.uuid()).max(1000) }).strict();

// ── Lectura ─────────────────────────────────────────────────────────────────

async function locationsByService(tx: Tx, businessId: string, serviceIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (serviceIds.length === 0) return out;
  const rows = await tx
    .select({ serviceId: serviceLocations.serviceId, locationId: serviceLocations.locationId })
    .from(serviceLocations)
    .where(and(eq(serviceLocations.businessId, businessId), inArray(serviceLocations.serviceId, [...serviceIds])));
  for (const r of rows) out.set(r.serviceId, [...(out.get(r.serviceId) ?? []), r.locationId].sort());
  return out;
}

async function readServices(tx: Tx, businessId: string, extra: SQL[] = []): Promise<ServiceView[]> {
  const rows = await tx
    .select({ service: services, categoryPosition: serviceCategories.position })
    .from(services)
    .leftJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(and(eq(services.businessId, businessId), ...extra));
  // Sin categoría ("Otros") al final; dentro de cada categoría, por posición.
  rows.sort(
    (a, b) =>
      (a.categoryPosition ?? Number.MAX_SAFE_INTEGER) - (b.categoryPosition ?? Number.MAX_SAFE_INTEGER) ||
      (a.service.categoryId ?? "").localeCompare(b.service.categoryId ?? "") ||
      a.service.position - b.service.position ||
      a.service.createdAt.getTime() - b.service.createdAt.getTime(),
  );
  const locs = await locationsByService(
    tx,
    businessId,
    rows.map((r) => r.service.id),
  );
  return rows.map((r) => toService(r.service, locs.get(r.service.id) ?? []));
}

async function readService(tx: Tx, businessId: string, serviceId: string): Promise<ServiceView> {
  const [view] = await readServices(tx, businessId, [eq(services.id, serviceId)]);
  if (!view) throw serviceNotFound();
  return view;
}

async function readCategories(tx: Tx, businessId: string): Promise<CategoryView[]> {
  const rows = await tx
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.businessId, businessId))
    .orderBy(asc(serviceCategories.position), asc(serviceCategories.createdAt));
  return rows.map(toCategory);
}

/** Catálogo completo (activos e inactivos) para Configuración > Servicios. */
export function getCatalog(db: Executor, businessId: string): Promise<CatalogView> {
  return withTenant(db, businessId, async (tx) => ({
    categories: await readCategories(tx, businessId),
    services: await readServices(tx, businessId),
  }));
}

// ── API pública (agenda, agente) ────────────────────────────────────────────

/**
 * Servicios del negocio en el orden del catálogo.
 *   • `activeOnly`: sin los desactivados.
 *   • `onlineOnly`: solo los que puede agendar el agente o la reserva web.
 *   • `locationId`: solo los que se ofrecen en esa sucursal (sin sucursales = en todas).
 */
export async function getServices(
  executor: Executor,
  businessId: string,
  options: { activeOnly?: boolean; onlineOnly?: boolean; locationId?: string } = {},
): Promise<ServiceView[]> {
  const extra: SQL[] = [];
  if (options.activeOnly) extra.push(eq(services.active, true));
  if (options.onlineOnly) extra.push(eq(services.onlineBooking, true));
  const all = await withTenant(executor, businessId, (tx) => readServices(tx, businessId, extra));
  const locationId = options.locationId?.toLowerCase();
  return locationId ? all.filter((s) => s.locationIds.length === 0 || s.locationIds.includes(locationId)) : all;
}

/** Un servicio del negocio, o null. */
export async function getService(executor: Executor, businessId: string, serviceId: string): Promise<ServiceView | null> {
  const [view] = await withTenant(executor, businessId, (tx) => readServices(tx, businessId, [eq(services.id, serviceId)]));
  return view ?? null;
}

/**
 * ¿Algún servicio se ofrece SOLO en algunas sucursales que incluyen esta? (filas en
 * service_locations). Lo usa business al borrar una sucursal: si la borrara, un servicio
 * que se ofrecía solo ahí quedaría sin filas = "en todas"; en ese caso se desactiva.
 */
export async function isLocationRestrictingServices(executor: Executor, businessId: string, locationId: string): Promise<boolean> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: serviceLocations.serviceId })
      .from(serviceLocations)
      .where(and(eq(serviceLocations.businessId, businessId), eq(serviceLocations.locationId, locationId)))
      .limit(1),
  );
  return rows.length > 0;
}

// ── Escritura: categorías ───────────────────────────────────────────────────

async function record(tx: Tx, session: Session, entity: string, entityId: string, snapshot: unknown): Promise<void> {
  await recordConfigChange(tx, { businessId: session.businessId, entity, entityId, snapshot, changedBy: session.userId });
}

export async function createCategory(db: Executor, session: Session, name: string): Promise<CategoryView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const [{ last }] = await tx
      .select({ last: max(serviceCategories.position) })
      .from(serviceCategories)
      .where(eq(serviceCategories.businessId, businessId));
    const [row] = await tx
      .insert(serviceCategories)
      .values({ businessId, name, position: (last ?? -1) + 1 })
      .returning();
    const view = toCategory(row);
    await record(tx, session, "service_category", view.id, view);
    return view;
  });
}

export async function renameCategory(db: Executor, session: Session, categoryId: string, name: string): Promise<CategoryView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const [row] = await tx
      .update(serviceCategories)
      .set({ name })
      .where(and(eq(serviceCategories.id, categoryId), eq(serviceCategories.businessId, businessId)))
      .returning();
    if (!row) throw categoryNotFound();
    const view = toCategory(row);
    await record(tx, session, "service_category", view.id, view);
    return view;
  });
}

/** Siguiente posición libre dentro de una categoría (null = sin categoría). */
async function nextServicePosition(tx: Tx, businessId: string, categoryId: string | null): Promise<number> {
  const [{ last }] = await tx
    .select({ last: max(services.position) })
    .from(services)
    .where(and(eq(services.businessId, businessId), categoryId ? eq(services.categoryId, categoryId) : isNull(services.categoryId)));
  return (last ?? -1) + 1;
}

/** Borra la categoría; sus servicios pasan a "sin categoría", al final. */
export async function deleteCategory(db: Executor, session: Session, categoryId: string): Promise<void> {
  const { businessId } = session;
  await withTenant(db, businessId, async (tx) => {
    const [current] = await tx
      .select()
      .from(serviceCategories)
      .where(and(eq(serviceCategories.id, categoryId), eq(serviceCategories.businessId, businessId)))
      .for("update");
    if (!current) throw categoryNotFound();
    const moved = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.businessId, businessId), eq(services.categoryId, categoryId)))
      .orderBy(asc(services.position), asc(services.createdAt));
    let position = await nextServicePosition(tx, businessId, null);
    for (const s of moved) {
      await tx
        .update(services)
        .set({ categoryId: null, position: position++ })
        .where(eq(services.id, s.id));
    }
    await tx.delete(serviceCategories).where(eq(serviceCategories.id, current.id));
    await record(tx, session, "service_category", current.id, { ...toCategory(current), deleted: true, movedServices: moved.length });
  });
}

export async function reorderCategories(db: Executor, session: Session, ids: readonly string[]): Promise<CategoryView[]> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const current = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.businessId, businessId))
      .orderBy(asc(serviceCategories.id))
      .for("update");
    assertSameIds(
      current.map((r) => r.id),
      ids,
    );
    for (const [position, id] of ids.entries()) {
      await tx
        .update(serviceCategories)
        .set({ position })
        .where(and(eq(serviceCategories.id, id.toLowerCase()), eq(serviceCategories.businessId, businessId)));
    }
    await record(tx, session, "service_categories_order", businessId, { ids: ids.map((id) => id.toLowerCase()) });
    return readCategories(tx, businessId);
  });
}

// ── Escritura: servicios ────────────────────────────────────────────────────

async function assertCategory(tx: Tx, businessId: string, categoryId: string): Promise<void> {
  const [row] = await tx
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(and(eq(serviceCategories.id, categoryId), eq(serviceCategories.businessId, businessId)))
    .limit(1);
  if (!row) throw new ValidationError({ "body.categoryId": "Esa categoría no existe." });
}

async function replaceServiceLocations(tx: Tx, businessId: string, serviceId: string, locationIds: readonly string[]): Promise<void> {
  await tx.delete(serviceLocations).where(eq(serviceLocations.serviceId, serviceId));
  const ids = [...new Set(locationIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return;
  await tx.insert(serviceLocations).values(ids.map((locationId) => ({ businessId, serviceId, locationId })));
}

export async function createService(db: Executor, session: Session, input: z.output<typeof NewServiceInput>): Promise<ServiceView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const categoryId = input.categoryId?.toLowerCase() ?? null;
    if (categoryId) await assertCategory(tx, businessId, categoryId);
    if (input.locationIds?.length) await assertLocationsOfBusiness(tx, businessId, input.locationIds);
    const [row] = await tx
      .insert(services)
      .values({
        businessId,
        categoryId,
        name: input.name,
        description: input.description ?? null,
        durationMin: input.durationMin,
        bufferMin: input.bufferMin ?? 0,
        priceCents: input.priceCents ?? 0,
        variablePrice: input.variablePrice ?? false,
        onlineBooking: input.onlineBooking ?? true,
        active: input.active ?? true,
        position: await nextServicePosition(tx, businessId, categoryId),
      })
      .returning({ id: services.id });
    await replaceServiceLocations(tx, businessId, row.id, input.locationIds ?? []);
    const view = await readService(tx, businessId, row.id);
    await record(tx, session, "service", view.id, view);
    return view;
  });
}

export async function updateService(db: Executor, session: Session, serviceId: string, patch: z.output<typeof ServicePatch>): Promise<ServiceView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const [current] = await tx
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), eq(services.businessId, businessId)))
      .for("update");
    if (!current) throw serviceNotFound();
    const { locationIds, ...fields } = patch;
    const changes: Partial<typeof services.$inferInsert> = { ...fields };
    if (fields.categoryId !== undefined) {
      const categoryId = fields.categoryId?.toLowerCase() ?? null;
      if (categoryId) await assertCategory(tx, businessId, categoryId);
      changes.categoryId = categoryId;
      // Cambia de categoría: va al final de la nueva.
      if (categoryId !== current.categoryId) changes.position = await nextServicePosition(tx, businessId, categoryId);
    }
    if (Object.keys(changes).length > 0) await tx.update(services).set(changes).where(eq(services.id, current.id));
    if (locationIds !== undefined) {
      await assertLocationsOfBusiness(tx, businessId, locationIds);
      await replaceServiceLocations(tx, businessId, current.id, locationIds);
    }
    const view = await readService(tx, businessId, current.id);
    await record(tx, session, "service", view.id, view);
    return view;
  });
}

export async function deleteService(db: Executor, session: Session, serviceId: string): Promise<void> {
  const { businessId } = session;
  await withTenant(db, businessId, async (tx) => {
    const current = await readService(tx, businessId, serviceId);
    await tx.delete(services).where(and(eq(services.id, current.id), eq(services.businessId, businessId)));
    await record(tx, session, "service", current.id, { ...current, deleted: true });
  });
}

/** Nuevo orden de los servicios de UNA categoría (null = sin categoría): `ids` = todos los de ahí. */
export async function reorderServices(
  db: Executor,
  session: Session,
  input: { categoryId: string | null; ids: readonly string[] },
): Promise<ServiceView[]> {
  const { businessId } = session;
  const categoryId = input.categoryId?.toLowerCase() ?? null;
  return withTenant(db, businessId, async (tx) => {
    const current = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.businessId, businessId), categoryId ? eq(services.categoryId, categoryId) : isNull(services.categoryId)))
      .orderBy(asc(services.id))
      .for("update");
    assertSameIds(
      current.map((r) => r.id),
      input.ids,
    );
    for (const [position, id] of input.ids.entries()) {
      await tx
        .update(services)
        .set({ position })
        .where(and(eq(services.id, id.toLowerCase()), eq(services.businessId, businessId)));
    }
    await record(tx, session, "services_order", categoryId ?? businessId, { categoryId, ids: input.ids.map((id) => id.toLowerCase()) });
    return readServices(tx, businessId);
  });
}
