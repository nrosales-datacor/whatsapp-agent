import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { assertLocationAccess } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getBusinessContext, type BusinessContext } from "../business";
import { addDays, isLocalDate, localDate, localDayBounds } from "../scheduling";

// ─────────────────────────────────────────────────────────────────────────────
// Rango y sucursal de un reporte (I5):
//
//   • `from` y `to` son días locales ("AAAA-MM-DD", AMBOS inclusive) en la zona del
//     NEGOCIO. Default: los últimos 30 días hasta hoy. Hasta 366 días.
//   • El período anterior (para comparar y para la retención) es el mismo largo, justo
//     antes de `from`.
//   • Sucursal: `locationId` de la query, o el header `X-Location-Id`, o todas las que ve
//     la sesión. Una sesión limitada a algunas sucursales no ve las otras (403).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_REPORT_DAYS = 366;
export const DEFAULT_REPORT_DAYS = 30;

const LocalDate = z.string().refine(isLocalDate, "Fecha inválida (formato AAAA-MM-DD).");

export const ReportQuery = z.object({
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  locationId: z.uuid().optional(),
});
export type ReportQueryInput = z.output<typeof ReportQuery>;

/** Rango tal como sale en la respuesta de cada reporte. */
export interface RangeView {
  /** Primer y último día (inclusive), en la zona del negocio. */
  from: string;
  to: string;
  days: number;
  timezone: string;
  /** Sucursal elegida (null = todas las que ve la sesión). */
  locationId: string | null;
  /** Período anterior del mismo largo (inclusive). */
  previous: { from: string; to: string };
}

export interface ReportScope {
  view: RangeView;
  /** [inicio del primer día, fin del último) como instantes. */
  start: Date;
  end: Date;
  previousStart: Date;
  /** Sucursales del reporte (null = todas las del negocio). */
  locationIds: string[] | null;
  ctx: BusinessContext;
}

/** Días entre dos fechas locales (b − a), con aritmética UTC (no depende de la zona). */
export function daysBetween(a: string, b: string): number {
  const ms = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Todos los días de [from, to] (inclusive), en orden. */
export function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_REPORT_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

export async function businessContextOf(db: Executor, businessId: string): Promise<BusinessContext> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx;
}

/** Sucursales que ve el reporte: la pedida (validada) o todas las de la sesión. */
export function locationScope(
  ctx: BusinessContext,
  session: Pick<Session, "locationIds">,
  requested: string | null | undefined,
): { locationId: string | null; locationIds: string[] | null } {
  const id = requested?.toLowerCase() ?? null;
  if (id) {
    assertLocationAccess(session, id);
    if (!ctx.locations.some((l) => l.id === id)) throw new ValidationError({ "query.locationId": "Esa sucursal no existe." });
    return { locationId: id, locationIds: [id] };
  }
  return { locationId: null, locationIds: session.locationIds === "all" ? null : [...session.locationIds] };
}

/** Resuelve rango, período anterior y sucursales de un reporte (400 si el rango no vale). */
export async function resolveReportScope(
  db: Executor,
  session: Session,
  query: ReportQueryInput,
  headerLocationId: string | null,
  now: Date = new Date(),
): Promise<ReportScope> {
  const ctx = await businessContextOf(db, session.businessId);
  const timezone = ctx.business.timezone;
  const to = query.to ?? localDate(now, timezone);
  const from = query.from ?? addDays(to, -(DEFAULT_REPORT_DAYS - 1));
  if (from > to) throw new ValidationError({ "query.to": "El fin tiene que ser igual o posterior al inicio." });
  const days = daysBetween(from, to) + 1;
  if (days > MAX_REPORT_DAYS) throw new ValidationError({ "query.to": `El rango puede ser de a lo sumo ${MAX_REPORT_DAYS} días.` });
  const previous = { from: addDays(from, -days), to: addDays(from, -1) };
  const { locationId, locationIds } = locationScope(ctx, session, query.locationId ?? headerLocationId);
  return {
    view: { from, to, days, timezone, locationId, previous },
    start: localDayBounds(from, timezone).start,
    end: localDayBounds(to, timezone).end,
    previousStart: localDayBounds(previous.from, timezone).start,
    locationIds,
    ctx,
  };
}
