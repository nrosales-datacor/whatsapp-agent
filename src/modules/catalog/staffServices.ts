import { and, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getStaffMember, listStaff } from "../team";
import { DurationMin, getService, PriceCents } from "./services";
import { services, staffServices, type StaffService } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Qué servicios hace cada profesional, con precio y duración propios opcionales (senior
// vs. junior), y la pregunta que se hace la agenda: "¿quién puede hacer este servicio en
// esta sucursal, y en cuánto tiempo y a qué precio?" (`listBookableStaff`).
//
//   • Un profesional SIN filas hace todos los servicios (el dueño que solo carga nombres
//     no tiene que configurar nada más). Con filas, solo esos.
//   • `priceCents` / `durationMin` en null = los del servicio.
//   • Vive en catalog (la tabla es del catálogo) aunque la ruta cuelgue de
//     /settings/staff/:id: catalog depende de team, no al revés.
// ─────────────────────────────────────────────────────────────────────────────

/** Precio/duración propios de un profesional para un servicio (null = los del servicio). */
export interface StaffServiceOverride {
  staffId: string;
  serviceId: string;
  priceCents: number | null;
  durationMin: number | null;
}

export interface StaffServicesView {
  staffId: string;
  /** true = sin filas: hace todos los servicios (con sus valores de catálogo). */
  allServices: boolean;
  services: Array<Omit<StaffServiceOverride, "staffId">>;
}

/** Condiciones efectivas de un servicio para un profesional (overrides aplicados). */
export interface EffectiveServiceTerms {
  serviceId: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  variablePrice: boolean;
}

/** Profesional que puede atender (API pública: agenda y agente). */
export interface BookableStaff {
  id: string;
  name: string;
  color: string | null;
  position: number;
  /** Condiciones del servicio pedido para esta persona; null si no se pidió un servicio. */
  service: EffectiveServiceTerms | null;
}

function toOverride(r: StaffService): StaffServiceOverride {
  return { staffId: r.staffId, serviceId: r.serviceId, priceCents: r.priceCents, durationMin: r.durationMin };
}

// ── Validación ──────────────────────────────────────────────────────────────

export const StaffServicesInput = z
  .object({
    services: z
      .array(
        z
          .object({
            serviceId: z.uuid(),
            priceCents: PriceCents.nullable().default(null),
            durationMin: DurationMin.nullable().default(null),
          })
          .strict(),
      )
      .max(1000)
      .refine((list) => new Set(list.map((s) => String(s?.serviceId).toLowerCase())).size === list.length, "Cada servicio va una sola vez."),
  })
  .strict();

// ── API pública ─────────────────────────────────────────────────────────────

/** Overrides de precio/duración por profesional, filtrados por profesional y/o servicio. */
export async function getStaffServiceOverrides(
  executor: Executor,
  businessId: string,
  filter: { staffId?: string; serviceId?: string } = {},
): Promise<StaffServiceOverride[]> {
  const conditions: SQL[] = [eq(staffServices.businessId, businessId)];
  if (filter.staffId) conditions.push(eq(staffServices.staffId, filter.staffId));
  if (filter.serviceId) conditions.push(eq(staffServices.serviceId, filter.serviceId));
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(staffServices)
      .where(and(...conditions)),
  );
  return rows.map(toOverride);
}

/**
 * Profesionales ACTIVOS que pueden atender, en el orden de la agenda:
 *   • con `locationId`: los que tienen horario en esa sucursal;
 *   • con `serviceId`: los que hacen ese servicio (sin filas = todos), con sus condiciones
 *     efectivas. Si el servicio no existe, está desactivado o no se ofrece en la sucursal
 *     pedida, la lista sale vacía.
 * No mira disponibilidad horaria (eso es de scheduling, con los horarios y ausencias).
 */
export async function listBookableStaff(
  executor: Executor,
  businessId: string,
  options: { locationId?: string; serviceId?: string } = {},
): Promise<BookableStaff[]> {
  const staffList = await listStaff(executor, businessId, { activeOnly: true, locationId: options.locationId });
  if (!options.serviceId) {
    return staffList.map((s) => ({ id: s.id, name: s.name, color: s.color, position: s.position, service: null }));
  }
  const service = await getService(executor, businessId, options.serviceId);
  if (!service || !service.active) return [];
  const locationId = options.locationId?.toLowerCase();
  if (locationId && service.locationIds.length > 0 && !service.locationIds.includes(locationId)) return [];

  const staffIds = staffList.map((s) => s.id);
  const rows =
    staffIds.length === 0
      ? []
      : await withTenant(executor, businessId, (tx) =>
          tx
            .select()
            .from(staffServices)
            .where(and(eq(staffServices.businessId, businessId), inArray(staffServices.staffId, staffIds))),
        );
  const byStaff = new Map<string, StaffService[]>();
  for (const r of rows) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);

  return staffList.flatMap((s): BookableStaff[] => {
    const own = byStaff.get(s.id) ?? [];
    const override = own.find((r) => r.serviceId === service.id);
    if (own.length > 0 && !override) return []; // tiene lista propia y este servicio no está
    return [
      {
        id: s.id,
        name: s.name,
        color: s.color,
        position: s.position,
        service: {
          serviceId: service.id,
          durationMin: override?.durationMin ?? service.durationMin,
          bufferMin: service.bufferMin,
          priceCents: override?.priceCents ?? service.priceCents,
          variablePrice: service.variablePrice,
        },
      },
    ];
  });
}

// ── Configuración > Equipo > Servicios ──────────────────────────────────────

const staffNotFound = () => new HttpError(404, "Ese profesional no existe.", "not_found");

export async function getStaffServices(db: Executor, businessId: string, staffId: string): Promise<StaffServicesView> {
  if (!(await getStaffMember(db, businessId, staffId))) throw staffNotFound();
  const rows = await getStaffServiceOverrides(db, businessId, { staffId });
  return {
    staffId: staffId.toLowerCase(),
    allServices: rows.length === 0,
    services: rows.map(({ staffId: _staffId, ...rest }) => rest),
  };
}

/** Reemplaza la lista de servicios del profesional. Lista vacía = hace todos. */
export async function replaceStaffServices(
  db: Executor,
  session: Session,
  staffId: string,
  items: z.output<typeof StaffServicesInput>["services"],
): Promise<StaffServicesView> {
  const { businessId } = session;
  if (!(await getStaffMember(db, businessId, staffId))) throw staffNotFound();
  await withTenant(db, businessId, async (tx) => {
    const ids = items.map((i) => i.serviceId.toLowerCase());
    if (ids.length > 0) {
      const known = await tx
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.businessId, businessId), inArray(services.id, ids)));
      if (known.length !== ids.length) throw new ValidationError({ "body.services": "Alguno de los servicios no existe en este negocio." });
    }
    await tx.delete(staffServices).where(and(eq(staffServices.businessId, businessId), eq(staffServices.staffId, staffId)));
    if (items.length > 0) {
      await tx.insert(staffServices).values(
        items.map((i) => ({
          businessId,
          staffId,
          serviceId: i.serviceId.toLowerCase(),
          priceCents: i.priceCents,
          durationMin: i.durationMin,
        })),
      );
    }
    await recordConfigChange(tx, {
      businessId,
      entity: "staff_services",
      entityId: staffId,
      snapshot: { services: items },
      changedBy: session.userId,
    });
  });
  return getStaffServices(db, businessId, staffId);
}
