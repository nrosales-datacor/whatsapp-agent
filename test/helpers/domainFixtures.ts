import { randomUUID } from "node:crypto";
import { businesses, locations } from "../../src/modules/business/schema";
import { clients } from "../../src/modules/clients/schema";
import { paymentMethods } from "../../src/modules/sales/schema";
import type { NewAppointment } from "../../src/modules/scheduling/schema";
import { staff } from "../../src/modules/team/schema";
import { withTenant, type Db } from "../../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Datos mínimos de un negocio para los tests que tocan el esquema del dominio: el
// negocio, una sucursal, N profesionales, un cliente y un método de pago. Todo se inserta
// con `withTenant` (el mismo camino que la app), así sirve también con la base corriendo
// como el rol `app_runtime` (sin BYPASSRLS).
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessFixture {
  businessId: string;
  locationId: string;
  staffIds: string[];
  clientId: string;
  paymentMethodId: string;
}

export async function createBusinessFixture(db: Db, options: { staffCount?: number } = {}): Promise<BusinessFixture> {
  const businessId = randomUUID();
  const staffCount = options.staffCount ?? 2;
  return withTenant(db, businessId, async (tx) => {
    await tx.insert(businesses).values({ id: businessId, slug: `negocio-${businessId.slice(0, 8)}`, name: "Negocio de prueba" });
    const [location] = await tx
      .insert(locations)
      .values({ businessId, name: "Central", timezone: "America/Costa_Rica" })
      .returning({ id: locations.id });
    const staffRows = await tx
      .insert(staff)
      .values(Array.from({ length: staffCount }, (_, i) => ({ businessId, name: `Profesional ${i + 1}` })))
      .returning({ id: staff.id });
    const [client] = await tx
      .insert(clients)
      .values({ businessId, name: "Cliente de prueba", phone: "+50688880000" })
      .returning({ id: clients.id });
    const [method] = await tx
      .insert(paymentMethods)
      .values({ businessId, name: "Efectivo" })
      .returning({ id: paymentMethods.id });
    return {
      businessId,
      locationId: location.id,
      staffIds: staffRows.map((s) => s.id),
      clientId: client.id,
      paymentMethodId: method.id,
    };
  });
}

/** Valores de una cita del negocio `f`: `start` ISO, `minutes` de duración, profesional `staffIndex`. */
export function appointmentValues(
  f: BusinessFixture,
  start: string,
  minutes: number,
  overrides: Partial<NewAppointment> & { staffIndex?: number } = {},
): NewAppointment {
  const { staffIndex = 0, ...rest } = overrides;
  const startsAt = new Date(start);
  return {
    businessId: f.businessId,
    locationId: f.locationId,
    clientId: f.clientId,
    staffId: f.staffIds[staffIndex],
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    status: "confirmed",
    ...rest,
  };
}

/** ¿El error (o alguno de su cadena de `cause`) trae este código de Postgres? Drizzle envuelve el original. */
export function hasPgCode(e: unknown, code: string): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if ((cur as { code?: string }).code === code) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
