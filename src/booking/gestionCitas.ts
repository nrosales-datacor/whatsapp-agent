import type { Cita, Repositorio, Tenant } from "../types";
import { actualizarEventoCita, calendarioConfigurado, crearEventoCita, eliminarEventoCita } from "../calendar/googleCalendar";

/**
 * "Hoy" ("YYYY-MM-DD") en la zona horaria del tenant. Usado para no agendar ni
 * reprogramar citas a una fecha pasada (bot y panel).
 */
export function hoyEnTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Refleja una cita recién creada en el Google Calendar del negocio (si está
 * configurado). Si Google falla, la cita YA quedó guardada: no se bloquea el
 * flujo que llama a esta función (bot o panel).
 */
export async function sincronizarCreacionGcal(tenant: Tenant, repo: Repositorio, cita: Cita): Promise<void> {
  if (!calendarioConfigurado(tenant)) return;
  try {
    const eventId = await crearEventoCita(tenant, cita);
    if (eventId) await repo.guardarGcalEventId(tenant.id, cita.id, eventId);
  } catch (e) {
    console.error(`[gcal] no se pudo crear el evento de la cita ${cita.id}:`, e);
  }
}

/** Refleja el nuevo horario de una cita reprogramada en su evento de Calendar (si tiene). */
export async function sincronizarReprogramacionGcal(tenant: Tenant, cita: Cita): Promise<void> {
  if (!calendarioConfigurado(tenant) || !cita.gcalEventId) return;
  try {
    await actualizarEventoCita(tenant, cita);
  } catch (e) {
    console.error(`[gcal] no se pudo actualizar el evento de la cita ${cita.id}:`, e);
  }
}

/**
 * Borra el evento de Calendar de una cita cancelada (si tiene). Recibe el `tenant`
 * porque el calendario es por negocio (auditoría BLOQ-05).
 */
export async function sincronizarCancelacionGcal(tenant: Tenant, cita: Cita): Promise<void> {
  if (!cita.gcalEventId) return;
  try {
    await eliminarEventoCita(tenant, cita.gcalEventId);
  } catch (e) {
    console.error(`[gcal] no se pudo borrar el evento de la cita ${cita.id}:`, e);
  }
}
