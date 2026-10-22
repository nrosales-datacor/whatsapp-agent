import { z } from "zod";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { assertAllLocationsAccess, MANAGER_ROLES } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { created, noContent, route } from "../../platform/http/router";
import type { Route, Session } from "../../platform/http/routeTypes";
import { getBusinessContext } from "../business";
import { addDays, isLocalDate, localDate, localDayBounds } from "../scheduling";
import { getStaffIdForUser } from "../team";
import { ENTRY_FILTER_STATUSES, getCommissionSummary, listCommissionEntries } from "./entries";
import { createPayout, deletePayout, getPayout, listPayouts, markPayoutPaid } from "./payouts";
import { CommissionRulePatch, createCommissionRule, deleteCommissionRule, listCommissionRules, NewCommissionRuleInput, updateCommissionRule } from "./rules";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Comisiones (I4, plan Pro: `module: "commissions"`). Montos en céntimos.
//
//   GET    /settings/commission-rules         dueño, admin
//   POST   /settings/commission-rules         dueño, admin
//   PATCH  /settings/commission-rules/:id     dueño, admin (tipo, valor, activa)
//   DELETE /settings/commission-rules/:id     dueño, admin
//   GET    /commissions/entries               dueño, admin, profesional ?staffId&from&to&status&payoutId
//   GET    /commissions/summary               dueño, admin, profesional ?from&to
//   GET    /commissions/payouts               dueño, admin, profesional ?staffId
//   POST   /commissions/payouts               dueño, admin { staffId, periodStart, periodEnd, note? }
//   POST   /commissions/payouts/:id/paid      dueño, admin
//   DELETE /commissions/payouts/:id           dueño, admin (solo sin pagar)
//
// Acceso:
//   • Profesional ("Mis comisiones"): solo lo suyo, siempre (pedir otro `staffId` → 403
//     `own_commissions_only`; sin profesional vinculado no ve nada).
//   • Recepción no ve comisiones (PLAN-GESTION.md §6).
//   • Dueño/admin limitado a algunas sucursales: ve los movimientos de esas; las
//     liquidaciones (que juntan todas las sucursales del profesional) piden acceso a todas.
// Fechas: días locales (AAAA-MM-DD, inclusive) en la zona del negocio.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionsRouteDeps {
  db: Executor;
}

const VIEWERS: readonly Role[] = ["owner", "admin", "staff"];
const MAX_RANGE_DAYS = 366;

const IdParams = z.object({ id: z.uuid() });
const LocalDate = z.string().refine(isLocalDate, "Fecha inválida (formato AAAA-MM-DD).");

const EntriesQuery = z.object({
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  staffId: z.uuid().optional(),
  status: z.enum(ENTRY_FILTER_STATUSES).optional(),
  payoutId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const SummaryQuery = z.object({ from: LocalDate.optional(), to: LocalDate.optional() });
const PayoutsQuery = z.object({ staffId: z.uuid().optional() });

const PayoutBody = z
  .object({
    staffId: z.uuid(),
    periodStart: LocalDate,
    periodEnd: LocalDate,
    note: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .optional()
      .transform((s) => (s ? s : null)),
  })
  .strict();

const ownOnly = () => new HttpError(403, "Solo podés ver tus propias comisiones.", "own_commissions_only");

/**
 * Profesional al que se acota la consulta: el propio para el rol `staff` (null = no tiene
 * uno vinculado → no ve nada), o el pedido (o todos) para dueño y admin.
 */
async function staffScope(db: Executor, session: Session, requested: string | undefined): Promise<{ staffId: string | null; none: boolean }> {
  if (session.role !== "staff") return { staffId: requested ?? null, none: false };
  const own = await getStaffIdForUser(db, session.businessId, session.userId);
  if (requested && requested !== own) throw ownOnly();
  return own ? { staffId: own, none: false } : { staffId: null, none: true };
}

/** Sucursales visibles: el profesional ve lo suyo en todas; dueño/admin, las de su sesión. */
function visibleLocations(session: Session): readonly string[] | null {
  if (session.role === "staff" || session.locationIds === "all") return null;
  return session.locationIds;
}

async function businessTimeZone(db: Executor, businessId: string): Promise<string> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx.business.timezone;
}

/** [inicio, fin) de un rango de días locales; default: del primero del mes a hoy. */
function dayRange(from: string | undefined, to: string | undefined, timeZone: string): { start: Date; end: Date } {
  const last = to ?? localDate(new Date(), timeZone);
  const first = from ?? `${last.slice(0, 8)}01`;
  if (first > last) throw new ValidationError({ "query.to": "El fin tiene que ser igual o posterior al inicio." });
  if (addDays(first, MAX_RANGE_DAYS) <= last) throw new ValidationError({ "query.to": `El rango puede ser de a lo sumo ${MAX_RANGE_DAYS} días.` });
  return { start: localDayBounds(first, timeZone).start, end: localDayBounds(last, timeZone).end };
}

export function commissionsRoutes({ db }: CommissionsRouteDeps): Route[] {
  return [
    // ── Reglas ──
    route({ method: "GET", path: "/settings/commission-rules", auth: "user", roles: MANAGER_ROLES, module: "commissions" }, ({ session }) =>
      listCommissionRules(db, session.businessId),
    ),

    route(
      { method: "POST", path: "/settings/commission-rules", auth: "user", roles: MANAGER_ROLES, module: "commissions", body: NewCommissionRuleInput },
      async ({ session, body }) => created(await createCommissionRule(db, session, body)),
    ),

    route(
      {
        method: "PATCH",
        path: "/settings/commission-rules/:id",
        auth: "user",
        roles: MANAGER_ROLES,
        module: "commissions",
        params: IdParams,
        body: CommissionRulePatch,
      },
      ({ session, params, body }) => updateCommissionRule(db, session, params.id, body),
    ),

    route(
      { method: "DELETE", path: "/settings/commission-rules/:id", auth: "user", roles: MANAGER_ROLES, module: "commissions", params: IdParams },
      async ({ session, params }) => {
        await deleteCommissionRule(db, session, params.id);
        return noContent();
      },
    ),

    // ── Movimientos y resumen ──
    route(
      { method: "GET", path: "/commissions/entries", auth: "user", roles: VIEWERS, module: "commissions", query: EntriesQuery },
      async ({ session, query }) => {
        const scope = await staffScope(db, session, query.staffId);
        if (scope.none) return { items: [], totalCents: 0, count: 0, truncated: false };
        const { start, end } = dayRange(query.from, query.to, await businessTimeZone(db, session.businessId));
        return listCommissionEntries(db, session.businessId, {
          from: start,
          to: end,
          staffId: scope.staffId,
          locationIds: visibleLocations(session),
          status: query.status ?? null,
          payoutId: query.payoutId ?? null,
          limit: query.limit,
        });
      },
    ),

    route(
      { method: "GET", path: "/commissions/summary", auth: "user", roles: VIEWERS, module: "commissions", query: SummaryQuery },
      async ({ session, query }) => {
        const scope = await staffScope(db, session, undefined);
        const empty = { rows: [], totals: { count: 0, baseCents: 0, amountCents: 0, openCents: 0, inPayoutCents: 0, paidCents: 0 } };
        if (scope.none) return empty;
        const { start, end } = dayRange(query.from, query.to, await businessTimeZone(db, session.businessId));
        return getCommissionSummary(db, session.businessId, { from: start, to: end, staffId: scope.staffId, locationIds: visibleLocations(session) });
      },
    ),

    // ── Liquidaciones ──
    route(
      { method: "GET", path: "/commissions/payouts", auth: "user", roles: VIEWERS, module: "commissions", query: PayoutsQuery },
      async ({ session, query }) => {
        const scope = await staffScope(db, session, query.staffId);
        if (scope.none) return [];
        if (session.role !== "staff") assertAllLocationsAccess(session);
        return listPayouts(db, session.businessId, { staffId: scope.staffId });
      },
    ),

    route(
      { method: "POST", path: "/commissions/payouts", auth: "user", roles: MANAGER_ROLES, module: "commissions", body: PayoutBody },
      async ({ session, body }) => {
        assertAllLocationsAccess(session);
        return created(await createPayout(db, session.businessId, body));
      },
    ),

    route(
      { method: "POST", path: "/commissions/payouts/:id/paid", auth: "user", roles: MANAGER_ROLES, module: "commissions", params: IdParams },
      ({ session, params }) => {
        assertAllLocationsAccess(session);
        return markPayoutPaid(db, session.businessId, params.id, { paidBy: session.userId });
      },
    ),

    route(
      { method: "DELETE", path: "/commissions/payouts/:id", auth: "user", roles: MANAGER_ROLES, module: "commissions", params: IdParams },
      async ({ session, params }) => {
        assertAllLocationsAccess(session);
        if (!(await getPayout(db, session.businessId, params.id))) throw new HttpError(404, "Esa liquidación no existe.", "not_found");
        await deletePayout(db, session.businessId, params.id);
        return noContent();
      },
    ),
  ];
}
