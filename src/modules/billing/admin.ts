import { z } from "zod";
import { listTenantAudit, recordAudit, type AuditEntry } from "../../platform/audit/auditLog";
import { withSystem, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { PlanUsageView } from "../../platform/plan/planHooks";
import {
  BILLING_STATUSES,
  getBusinessRow,
  invalidateBusinessContext,
  listBusinesses,
  updateBusinessSubscription,
  type Business,
  type BusinessSummary,
} from "../business";
import {
  LimitOverridesSchema,
  ModuleOverridesSchema,
  normalizeExtraModules,
  PLAN_IDS,
  toStoredExtraModules,
  type LimitOverrides,
  type ModuleName,
  type ModuleOverrides,
  type PlanLimits,
} from "./catalog";
import { billingStatusOfBusiness } from "./checkout";
import { resolveEntitlements } from "./entitlements";
import type { PlanService } from "./service";
import { isStripeTestMode, readStripeConfig } from "./stripeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// Lo del superadmin sobre los planes (cobro manual, PROCESO-COBRO-MANUAL.md):
//
//   • cambiar plan, módulos sueltos, cupos contratados y estado del cobro;
//   • pausar (sin servicio: la API del negocio responde 403 `business_paused` y la cola
//     posterga su trabajo nuevo; los datos quedan intactos) y reactivar;
//   • ver el detalle: plan efectivo, uso del mes y el rastro de auditoría.
//
// Cada cambio queda en `audit_log` en la MISMA transacción (o el cambio y su rastro, o
// ninguno), sin datos personales: solo plan, módulos, cupos, estados y el motivo de la
// pausa (texto del operador: no poner datos personales ahí). Al confirmar se invalida el
// caché del contexto en este proceso; los demás lo ven al vencer su TTL (30 s).
// ─────────────────────────────────────────────────────────────────────────────

/** `PATCH /admin/businesses/:id/plan`. `extraModules` y `limits` REEMPLAZAN lo contratado. */
export const PlanChangeInput = z
  .object({
    plan: z.enum(PLAN_IDS),
    extraModules: ModuleOverridesSchema,
    limits: LimitOverridesSchema,
    billingStatus: z.enum(BILLING_STATUSES),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Indicá qué cambiar (plan, módulos, límites o estado del cobro)." });

export type PlanChangeInputValue = z.output<typeof PlanChangeInput>;

/** `POST /admin/businesses/:id/pause`. */
export const PauseInput = z
  .object({ reason: z.string().trim().max(200).optional() })
  .strict();

/** Fila de la lista del superadmin. */
export interface AdminBusinessRow extends Omit<BusinessSummary, "extraModules"> {
  /** "Básico", "Pro" o "Pro sin agente". */
  planLabel: string;
  modules: ModuleName[];
}

/** Detalle de un negocio para el superadmin. */
export interface AdminBusinessDetail {
  business: AdminBusinessRow;
  clientsTier: string;
  /** Límites efectivos (con lo contratado), incluido el tope interno de gasto de LLM. */
  limits: PlanLimits;
  /** Lo contratado encima del plan. */
  overrides: { modules: ModuleOverrides; limits: LimitOverrides };
  usage: PlanUsageView;
  /** Últimos cambios del negocio (más reciente primero). */
  audit: AuditEntry[];
  /** Cobro en línea (Stripe) y vencimientos del negocio. */
  stripe: AdminStripeView;
}

/** Cobro en línea de un negocio, como lo ve el superadmin (ids públicos de Stripe, sin secretos). */
export interface AdminStripeView {
  /** ¿Stripe está configurado en el servidor? */
  configured: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  /** Estado crudo de la suscripción en Stripe (`active`, `past_due`, `canceled`…). */
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  /** Cuándo lo pausa el barrido si no paga (atraso + gracia). */
  pauseAt: string | null;
  /** Fin de la prueba del alta self-service (null = cobro manual, sin vencimiento). */
  trialEndsAt: string | null;
  /** ¿Está pausado por el cobro? (al pagar se reactiva solo). */
  billingPaused: boolean;
  /** Link al cliente en el Dashboard de Stripe. */
  dashboardUrl: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function stripeViewOf(business: Business): AdminStripeView {
  const config = readStripeConfig();
  const status = billingStatusOfBusiness(business);
  const dashboard = config && isStripeTestMode(config) ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
  return {
    configured: config !== null,
    customerId: business.stripeCustomerId,
    subscriptionId: business.stripeSubscriptionId,
    subscriptionStatus: business.stripeSubscriptionStatus,
    currentPeriodEnd: iso(business.currentPeriodEnd),
    cancelAtPeriodEnd: business.cancelAtPeriodEnd,
    pastDueSince: iso(business.pastDueSince),
    pauseAt: status.pauseAt,
    trialEndsAt: iso(business.trialEndsAt),
    billingPaused: business.status === "paused" && business.billingPausedAt !== null,
    dashboardUrl: business.stripeCustomerId ? `${dashboard}/customers/${encodeURIComponent(business.stripeCustomerId)}` : null,
  };
}

const notFound = () => new HttpError(404, "Ese negocio no existe.", "not_found");

function toRow(summary: BusinessSummary): AdminBusinessRow {
  const { extraModules: _extra, ...rest } = summary;
  const e = resolveEntitlements(summary);
  return { ...rest, planLabel: e.label, modules: e.modules };
}

function rowOf(business: Business, locationCount: number): AdminBusinessRow {
  return toRow({
    id: business.id,
    name: business.name,
    slug: business.slug,
    industry: business.industry,
    plan: business.plan,
    extraModules: business.extraModules,
    status: business.status,
    billingStatus: business.billingStatus,
    currency: business.currency,
    country: business.country,
    timezone: business.timezone,
    locationCount,
    createdAt: business.createdAt.toISOString(),
  });
}

/** Todos los negocios (los más nuevos primero) con su plan efectivo. */
export async function listAdminBusinesses(db: Executor): Promise<AdminBusinessRow[]> {
  return (await listBusinesses(db)).map(toRow);
}

/** Fila de la lista a partir de un resumen (p. ej. el alta recién hecha). */
export function adminRowOf(summary: BusinessSummary): AdminBusinessRow {
  return toRow(summary);
}

export async function getAdminBusinessDetail(db: Executor, plans: Pick<PlanService, "usage">, businessId: string): Promise<AdminBusinessDetail> {
  const business = await getBusinessRow(db, businessId);
  if (!business) throw notFound();
  const e = resolveEntitlements(business);
  const [usage, audit] = await Promise.all([plans.usage(businessId), listTenantAudit(db, businessId, 30)]);
  return {
    business: rowOf(business, usage.locations),
    clientsTier: e.clientsTier,
    limits: e.limits,
    overrides: e.overrides,
    usage,
    audit,
    stripe: stripeViewOf(business),
  };
}

/** Lo auditado de un cambio de plan: sin datos personales. */
function planState(business: Business) {
  const e = resolveEntitlements(business);
  return { plan: e.plan, modules: e.modules, overrides: e.overrides, billingStatus: e.billingStatus };
}

export async function changeBusinessPlan(db: Executor, businessId: string, input: PlanChangeInputValue, actor: string): Promise<Business> {
  const result = await withSystem(db, async (tx) => {
    const changed = await updateBusinessSubscription(tx, businessId, (current) => {
      const current_ = resolveEntitlements(current);
      const plan = input.plan ?? current_.plan;
      // Lo que no viene se conserva; lo que viene reemplaza. Se normaliza contra el plan
      // NUEVO (sumar un módulo que el plan ya trae no se guarda).
      const extra = normalizeExtraModules(plan, {
        modules: input.extraModules ?? current_.overrides.modules,
        limits: input.limits ?? current_.overrides.limits,
      });
      // Marcarlo al día (o en otro estado que no sea atrasado) frena la pausa automática por atraso.
      const pastDue = input.billingStatus !== undefined && input.billingStatus !== "past_due" ? { pastDueSince: null } : {};
      return { plan, extraModules: toStoredExtraModules(extra), billingStatus: input.billingStatus, ...pastDue };
    });
    if (!changed) throw notFound();
    await recordAudit(tx, businessId, "plan_changed", actor, { before: planState(changed.before), after: planState(changed.after) });
    return changed.after;
  });
  invalidateBusinessContext(businessId);
  return result;
}

export async function pauseBusiness(db: Executor, businessId: string, reason: string | undefined, actor: string): Promise<Business> {
  const result = await withSystem(db, async (tx) => {
    const changed = await updateBusinessSubscription(tx, businessId, (current) => {
      if (current.status === "paused") throw new HttpError(409, "El negocio ya estaba pausado.", "already_paused");
      if (current.status !== "active") throw new HttpError(409, "El negocio está dado de baja.", "business_closed");
      // Pausa del superadmin (no del cobro): el dueño no la puede levantar pagando.
      return { status: "paused", billingPausedAt: null };
    });
    if (!changed) throw notFound();
    await recordAudit(tx, businessId, "business_paused", actor, { reason: reason || null, billingStatus: changed.after.billingStatus });
    return changed.after;
  });
  invalidateBusinessContext(businessId);
  return result;
}

export async function reactivateBusiness(db: Executor, businessId: string, actor: string): Promise<Business> {
  const result = await withSystem(db, async (tx) => {
    const changed = await updateBusinessSubscription(tx, businessId, (current) => {
      if (current.status === "active") throw new HttpError(409, "El negocio ya estaba activo.", "already_active");
      if (current.status !== "paused") throw new HttpError(409, "El negocio está dado de baja.", "business_closed");
      return { status: "active", billingPausedAt: null };
    });
    if (!changed) throw notFound();
    await recordAudit(tx, businessId, "business_reactivated", actor, { billingStatus: changed.after.billingStatus });
    return changed.after;
  });
  invalidateBusinessContext(businessId);
  return result;
}
