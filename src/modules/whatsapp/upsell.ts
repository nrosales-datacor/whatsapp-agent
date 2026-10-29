import { and, eq } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import type { AppointmentView } from "../scheduling";
import { conversations, type DeclinedUpsell, type UpsellRule } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Upsell del agente (I6.4, portado del Carril D 1.2). El dueño define reglas "a quien
// agenda X, ofrecele agregar Y" (configuración de crecimiento). Tras agendar, si alguna
// regla aplica, `book_appointment` le devuelve al modelo la oferta; el modelo la hace UNA
// vez en la confirmación. Si el cliente acepta, `add_service_to_appointment` alarga la cita
// con la misma persona (scheduling re-chequea horario y solapes); si no, `decline_upsell`
// lo anota en la conversación y no se le vuelve a ofrecer ese servicio por un tiempo.
// ─────────────────────────────────────────────────────────────────────────────

/** Días durante los que no se vuelve a ofrecer un servicio que el cliente rechazó. */
export const DECLINED_UPSELL_DAYS = 60;
/** Rechazos que se recuerdan por conversación (los más nuevos). */
const MAX_DECLINED = 20;

/** Servicio que se ofrece agregar (lo que el modelo necesita para ofrecerlo). */
export interface UpsellCandidate {
  serviceId: string;
  name: string;
  priceCents: number;
  variablePrice: boolean;
  durationMin: number;
}

/** "YYYY-MM-DD" de hace `days` días respecto de `today`. */
function daysBefore(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * La oferta para una cita recién agendada: la primera regla cuyo servicio está en la cita,
 * cuya sugerencia NO está ya en la cita, se agenda por este medio en esa sucursal y el
 * cliente no rechazó en los últimos `DECLINED_UPSELL_DAYS` días. Pura (sin I/O).
 */
export function pickUpsell(input: {
  rules: readonly UpsellRule[];
  appointment: Pick<AppointmentView, "services" | "locationId">;
  /** Servicios que el agente puede agendar (activos y en línea), con sus sucursales. */
  bookable: readonly (UpsellCandidate & { locationIds: readonly string[] })[];
  declined: readonly DeclinedUpsell[];
  today: string;
}): UpsellCandidate | null {
  const inAppointment = new Set(input.appointment.services.map((l) => l.serviceId).filter(Boolean));
  const cutoff = daysBefore(input.today, DECLINED_UPSELL_DAYS);
  const declined = new Set(input.declined.filter((d) => d.date >= cutoff).map((d) => d.serviceId));
  for (const rule of input.rules) {
    if (!inAppointment.has(rule.serviceId) || inAppointment.has(rule.suggestServiceId) || declined.has(rule.suggestServiceId)) continue;
    const service = input.bookable.find((s) => s.serviceId === rule.suggestServiceId);
    if (!service) continue;
    if (service.locationIds.length > 0 && !service.locationIds.includes(input.appointment.locationId)) continue;
    return { serviceId: service.serviceId, name: service.name, priceCents: service.priceCents, variablePrice: service.variablePrice, durationMin: service.durationMin };
  }
  return null;
}

/** Rechazos recordados de una conversación. */
export async function declinedUpsellsOf(executor: Executor, businessId: string, conversationId: string): Promise<DeclinedUpsell[]> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ declined: conversations.declinedUpsells })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
      .limit(1),
  );
  return Array.isArray(row?.declined) ? row.declined : [];
}

/** Anota que el cliente no quiso agregar `serviceId` (`date` = "YYYY-MM-DD" del negocio). */
export async function recordDeclinedUpsell(executor: Executor, businessId: string, conversationId: string, serviceId: string, date: string): Promise<void> {
  await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select({ declined: conversations.declinedUpsells })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
      .limit(1)
      .for("update");
    if (!row) return;
    const kept = (Array.isArray(row.declined) ? row.declined : []).filter((d) => d.serviceId !== serviceId);
    const next = [...kept, { serviceId, date }].slice(-MAX_DECLINED);
    await tx.update(conversations).set({ declinedUpsells: next }).where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)));
  });
}
