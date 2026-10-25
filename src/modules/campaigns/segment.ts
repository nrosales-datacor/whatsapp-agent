import { and, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { CLIENT_STATUSES, clientIdIn, type ClientFilters, type ClientScope, type ClientStatus } from "../clients";
import { addDays, clientIdsLapsedForService, clientIdsWithUpcomingAppointments, localDate } from "../scheduling";
import type { CampaignSegment } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Segmento de una campaña → filtros del CRM (clients) + alcance extra (subconsultas de
// scheduling). Se arma en el momento de enviar: "hace 60 días" es relativo a ese día, en la
// zona del negocio.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DAYS = 3650;
const DAYS_PER_MONTH = 30;

export const CampaignSegmentInput = z
  .object({
    statuses: z.array(z.enum(CLIENT_STATUSES)).max(CLIENT_STATUSES.length).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    vip: z.boolean().optional(),
    preferredLocationId: z.uuid().optional(),
    preferredStaffId: z.uuid().optional(),
    lastVisitMinDays: z.number().int().min(1).max(MAX_DAYS).optional(),
    lastVisitMaxDays: z.number().int().min(1).max(MAX_DAYS).optional(),
    lapsedService: z.object({ serviceId: z.uuid(), months: z.number().int().min(1).max(60) }).strict().optional(),
    excludeUpcoming: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.lastVisitMinDays === undefined || s.lastVisitMaxDays === undefined || s.lastVisitMinDays <= s.lastVisitMaxDays, {
    message: "El rango de la última visita está al revés.",
    path: ["lastVisitMaxDays"],
  });

/** Filtros del CRM y alcance extra de un segmento, a la fecha `now` en la zona `timeZone`. */
export function segmentQuery(businessId: string, segment: CampaignSegment, now: Date, timeZone: string): { filters: ClientFilters; scope: ClientScope } {
  const today = localDate(now, timeZone);
  const filters: ClientFilters = {
    statuses: segment.statuses?.length ? (segment.statuses as ClientStatus[]) : undefined,
    tags: segment.tags?.length ? segment.tags : undefined,
    vip: segment.vip,
    preferredLocationId: segment.preferredLocationId,
    preferredStaffId: segment.preferredStaffId,
    // "Hace al menos N días" = última visita hasta el día de hace N días (y viceversa).
    lastVisitTo: segment.lastVisitMinDays ? addDays(today, -segment.lastVisitMinDays) : undefined,
    lastVisitFrom: segment.lastVisitMaxDays ? addDays(today, -segment.lastVisitMaxDays) : undefined,
  };
  const conditions: SQL[] = [];
  if (segment.lapsedService) {
    const before = new Date(now.getTime() - segment.lapsedService.months * DAYS_PER_MONTH * 86_400_000);
    conditions.push(clientIdIn(clientIdsLapsedForService(businessId, segment.lapsedService.serviceId, before)));
  }
  if (segment.excludeUpcoming !== false) conditions.push(sql`NOT ${clientIdIn(clientIdsWithUpcomingAppointments(businessId, now))}`);
  return { filters, scope: conditions.length ? and(...conditions) : undefined };
}
