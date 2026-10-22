import { z } from "zod";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { assertLocationAccess, MANAGER_ROLES } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { created, route } from "../../platform/http/router";
import type { Route, Session } from "../../platform/http/routeTypes";
import { getBusinessContext } from "../business";
import { addDays, getAppointment, isLocalDate, localDate, localDayBounds, type AppointmentView } from "../scheduling";
import { getStaffIdForUser } from "../team";
import {
  createPaymentMethod,
  deletePaymentMethod,
  listPaymentMethods,
  NewPaymentMethodInput,
  PaymentMethodOrderInput,
  PaymentMethodPatch,
  reorderPaymentMethods,
  updatePaymentMethod,
} from "./paymentMethods";
import {
  getAppointmentBalance,
  getDailySummary,
  getPayment,
  listPayments,
  listPendingBalances,
  MAX_AMOUNT_CENTS,
  recordAppointmentPayment,
  recordClientPayment,
  refundPayment,
  type PaymentsChangedHook,
} from "./payments";
import { PAYMENT_KINDS } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Ventas (I4, plan Pro: `module: "sales"`). Montos en céntimos.
//
//   GET    /settings/payment-methods          todos (para cobrar hace falta la lista)
//   POST   /settings/payment-methods          dueño, admin
//   PUT    /settings/payment-methods/order    dueño, admin ({ ids } en el orden nuevo)
//   PATCH  /settings/payment-methods/:id      dueño, admin (nombre, activo)
//   DELETE /settings/payment-methods/:id      dueño, admin (con pagos: se desactiva)
//   POST   /appointments/:id/payments         dueño, admin, recepción (seña o cobro de la cita)
//   GET    /appointments/:id/balance          todos (el profesional, solo sus citas)
//   POST   /sales/payments                    dueño, admin, recepción (cobro suelto a un cliente)
//   GET    /sales/payments                    dueño, admin, recepción ?from&to&locationId&methodId&clientId&kind&appointmentId
//   POST   /sales/payments/:id/refund         dueño, admin (devolución parcial o total, con motivo)
//   GET    /sales/pending                     dueño, admin, recepción ?from&to&locationId&staffId
//   GET    /sales/summary                     dueño, admin, recepción ?date&locationId (caja del día)
//
// Sucursal: la de `locationId` en la query, o la del header `X-Location-Id`, o todas las
// de la sesión. Una sesión limitada a algunas sucursales solo cobra, devuelve y ve lo de
// esas (403 `location_forbidden`). Fechas de los filtros: días locales (AAAA-MM-DD,
// inclusive) en la zona de la sucursal elegida, o la del negocio.
// ─────────────────────────────────────────────────────────────────────────────

export interface SalesRouteDeps {
  db: Executor;
  /** Efectos internos de cobrar o devolver en una cita, en su transacción (la composición inyecta las comisiones). */
  onPaymentsChanged?: PaymentsChangedHook;
}

const DESK: readonly Role[] = ["owner", "admin", "front_desk"];
/** Rango máximo de los listados (un año). */
const MAX_RANGE_DAYS = 366;
/** Ventana default de Pendientes (días hacia atrás desde hoy). */
const PENDING_DEFAULT_DAYS = 90;
/** Ventana default de Cobros. */
const PAYMENTS_DEFAULT_DAYS = 30;

const IdParams = z.object({ id: z.uuid() });
const LocalDate = z.string().refine(isLocalDate, "Fecha inválida (formato AAAA-MM-DD).");
const Instant = z.iso.datetime({ offset: true, error: "Fecha y hora inválidas (ISO 8601 con zona)." }).transform((s) => new Date(s));
const Amount = z.int("El monto tiene que ser un número entero de céntimos.").min(1, "El monto tiene que ser mayor que cero.").max(MAX_AMOUNT_CENTS);
const Currency = z.string().trim().regex(/^[A-Za-z]{3}$/, "Moneda inválida (código ISO de 3 letras).");
const Note = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .transform((s) => (s ? s : null));
const ChargeKind = z.enum(["deposit", "payment"]);

const AppointmentPaymentBody = z
  .object({
    kind: ChargeKind.default("payment"),
    amountCents: Amount,
    methodId: z.uuid(),
    note: Note.optional(),
    paidAt: Instant.optional(),
    currency: Currency.optional(),
  })
  .strict();

const ClientPaymentBody = z
  .object({
    clientId: z.uuid(),
    locationId: z.uuid(),
    kind: ChargeKind.default("payment"),
    amountCents: Amount,
    methodId: z.uuid(),
    note: Note.optional(),
    paidAt: Instant.optional(),
    currency: Currency.optional(),
  })
  .strict();

const RefundBody = z
  .object({
    amountCents: Amount,
    reason: z.string().trim().min(1, "Contanos el motivo de la devolución.").max(500),
    methodId: z.uuid().optional(),
  })
  .strict();

const RangeFields = { from: LocalDate.optional(), to: LocalDate.optional(), locationId: z.uuid().optional() };

const PaymentsQuery = z.object({
  ...RangeFields,
  methodId: z.uuid().optional(),
  clientId: z.uuid().optional(),
  appointmentId: z.uuid().optional(),
  kind: z.enum(PAYMENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const PendingQuery = z.object({ ...RangeFields, staffId: z.uuid().optional(), clientId: z.uuid().optional() });

const SummaryQuery = z.object({ date: LocalDate.optional(), locationId: z.uuid().optional() });

// ── Acceso ──────────────────────────────────────────────────────────────────

interface Scope {
  /** null = todas las sucursales del negocio. */
  locationIds: string[] | null;
  /** La sucursal elegida, si se eligió una. */
  locationId: string | null;
}

/** Sucursales de un listado: la de la query, la del header o todas las de la sesión. */
function scopeOf(session: Session, queryLocationId: string | undefined, headerLocationId: string | null): Scope {
  const id = (queryLocationId ?? headerLocationId)?.toLowerCase() ?? null;
  if (id) {
    assertLocationAccess(session, id);
    return { locationIds: [id], locationId: id };
  }
  return { locationIds: session.locationIds === "all" ? null : [...session.locationIds], locationId: null };
}

/** Zona en la que se leen las fechas: la de la sucursal elegida o la del negocio. */
async function timeZoneOf(db: Executor, businessId: string, locationId: string | null): Promise<string> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const location = locationId ? ctx.locations.find((l) => l.id === locationId) : undefined;
  if (locationId && !location) throw new ValidationError({ "query.locationId": "Esa sucursal no existe." });
  return location?.timezone ?? ctx.business.timezone;
}

/** [inicio del primer día, fin del último) de un rango de días locales (con su default). */
function dayRange(from: string | undefined, to: string | undefined, timeZone: string, defaultDays: number): { start: Date; end: Date } {
  const last = to ?? localDate(new Date(), timeZone);
  const first = from ?? addDays(last, -(defaultDays - 1));
  if (first > last) throw new ValidationError({ "query.to": "El fin tiene que ser igual o posterior al inicio." });
  if (addDays(first, MAX_RANGE_DAYS) <= last) throw new ValidationError({ "query.to": `El rango puede ser de a lo sumo ${MAX_RANGE_DAYS} días.` });
  return { start: localDayBounds(first, timeZone).start, end: localDayBounds(last, timeZone).end };
}

const ownOnly = () => new HttpError(403, "Solo podés ver tus propias citas.", "own_appointments_only");

/** La cita, si la sesión la puede ver (404 si no existe; 403 de otra sucursal o, para el profesional, de otro). */
async function accessibleAppointment(db: Executor, session: Session, id: string): Promise<AppointmentView> {
  const appointment = await getAppointment(db, session.businessId, id);
  if (!appointment) throw new HttpError(404, "No encontramos esa cita.", "not_found");
  assertLocationAccess(session, appointment.locationId);
  if (session.role === "staff") {
    const own = await getStaffIdForUser(db, session.businessId, session.userId);
    if (!own || appointment.staffId !== own) throw ownOnly();
  }
  return appointment;
}

export function salesRoutes({ db, onPaymentsChanged }: SalesRouteDeps): Route[] {
  return [
    // ── Métodos de pago ──
    route({ method: "GET", path: "/settings/payment-methods", auth: "user", module: "sales" }, ({ session }) =>
      listPaymentMethods(db, session.businessId),
    ),

    route(
      { method: "POST", path: "/settings/payment-methods", auth: "user", roles: MANAGER_ROLES, module: "sales", body: NewPaymentMethodInput },
      async ({ session, body }) => created(await createPaymentMethod(db, session, body.name)),
    ),

    route(
      { method: "PUT", path: "/settings/payment-methods/order", auth: "user", roles: MANAGER_ROLES, module: "sales", body: PaymentMethodOrderInput },
      ({ session, body }) => reorderPaymentMethods(db, session, body.ids),
    ),

    route(
      { method: "PATCH", path: "/settings/payment-methods/:id", auth: "user", roles: MANAGER_ROLES, module: "sales", params: IdParams, body: PaymentMethodPatch },
      ({ session, params, body }) => updatePaymentMethod(db, session, params.id, body),
    ),

    route(
      { method: "DELETE", path: "/settings/payment-methods/:id", auth: "user", roles: MANAGER_ROLES, module: "sales", params: IdParams },
      ({ session, params }) => deletePaymentMethod(db, session, params.id),
    ),

    // ── Cobrar desde la cita ──
    route(
      { method: "POST", path: "/appointments/:id/payments", auth: "user", roles: DESK, module: "sales", params: IdParams, body: AppointmentPaymentBody },
      async ({ session, params, body }) => {
        await accessibleAppointment(db, session, params.id);
        return created(
          await recordAppointmentPayment(db, session.businessId, {
            appointmentId: params.id,
            kind: body.kind,
            amountCents: body.amountCents,
            methodId: body.methodId,
            note: body.note ?? null,
            paidAt: body.paidAt ?? null,
            currency: body.currency ?? null,
            recordedBy: session.userId,
            onPaymentsChanged,
          }),
        );
      },
    ),

    route({ method: "GET", path: "/appointments/:id/balance", auth: "user", module: "sales", params: IdParams }, async ({ session, params }) => {
      await accessibleAppointment(db, session, params.id);
      return getAppointmentBalance(db, session.businessId, params.id);
    }),

    // ── Cobros ──
    route(
      { method: "POST", path: "/sales/payments", auth: "user", roles: DESK, module: "sales", body: ClientPaymentBody },
      async ({ session, body }) => {
        assertLocationAccess(session, body.locationId);
        return created(
          await recordClientPayment(db, session.businessId, {
            clientId: body.clientId,
            locationId: body.locationId,
            kind: body.kind,
            amountCents: body.amountCents,
            methodId: body.methodId,
            note: body.note ?? null,
            paidAt: body.paidAt ?? null,
            currency: body.currency ?? null,
            recordedBy: session.userId,
          }),
        );
      },
    ),

    route(
      { method: "GET", path: "/sales/payments", auth: "user", roles: DESK, module: "sales", location: "optional", query: PaymentsQuery },
      async ({ session, query, locationId }) => {
        const scope = scopeOf(session, query.locationId, locationId);
        const timeZone = await timeZoneOf(db, session.businessId, scope.locationId);
        const { start, end } = dayRange(query.from, query.to, timeZone, PAYMENTS_DEFAULT_DAYS);
        return listPayments(db, session.businessId, {
          from: start,
          to: end,
          locationIds: scope.locationIds,
          methodId: query.methodId ?? null,
          clientId: query.clientId ?? null,
          appointmentId: query.appointmentId ?? null,
          kind: query.kind ?? null,
          limit: query.limit,
        });
      },
    ),

    route(
      { method: "POST", path: "/sales/payments/:id/refund", auth: "user", roles: MANAGER_ROLES, module: "sales", params: IdParams, body: RefundBody },
      async ({ session, params, body }) => {
        const payment = await getPayment(db, session.businessId, params.id);
        if (!payment) throw new HttpError(404, "No encontramos ese pago.", "not_found");
        assertLocationAccess(session, payment.locationId);
        return created(
          await refundPayment(db, session.businessId, {
            paymentId: params.id,
            amountCents: body.amountCents,
            reason: body.reason,
            methodId: body.methodId ?? null,
            recordedBy: session.userId,
            onPaymentsChanged,
          }),
        );
      },
    ),

    // ── Pendientes y caja ──
    route(
      { method: "GET", path: "/sales/pending", auth: "user", roles: DESK, module: "sales", location: "optional", query: PendingQuery },
      async ({ session, query, locationId }) => {
        const scope = scopeOf(session, query.locationId, locationId);
        const timeZone = await timeZoneOf(db, session.businessId, scope.locationId);
        const { start, end } = dayRange(query.from, query.to, timeZone, PENDING_DEFAULT_DAYS);
        return listPendingBalances(db, session.businessId, {
          from: start,
          to: end,
          locationIds: scope.locationIds,
          staffId: query.staffId ?? null,
          clientId: query.clientId ?? null,
        });
      },
    ),

    route(
      { method: "GET", path: "/sales/summary", auth: "user", roles: DESK, module: "sales", location: "optional", query: SummaryQuery },
      async ({ session, query, locationId }) => {
        const scope = scopeOf(session, query.locationId, locationId);
        const timeZone = await timeZoneOf(db, session.businessId, scope.locationId);
        return getDailySummary(db, session.businessId, {
          date: query.date ?? localDate(new Date(), timeZone),
          timezone: timeZone,
          locationIds: scope.locationIds,
          locationId: scope.locationId,
        });
      },
    ),
  ];
}
