import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { BillingAccount, Plan, PlanBilling, Role } from "../../lib/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Cobro en línea en la API simulada (VITE_MOCK_API=1), con la forma de src/modules/billing.
// Stripe no existe acá: "Suscribirme" y "Gestionar pago" simulan lo que haría Stripe y
// su webhook al volver (la suscripción queda viva, el plan elegido, el cobro al día y, si
// estaba pausada por el cobro, la cuenta se reactiva) y devuelven la URL de vuelta al panel.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo del cobro de un negocio simulado (vive en lib/mockApi.ts junto al plan). */
export interface MockBillingFields {
  plan: Plan;
  billingStatus: string;
  status: string;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  pastDueSince?: string | null;
  /** ¿Tiene cliente en Stripe? */
  stripeCustomer?: boolean;
  /** ¿Tiene una suscripción viva en Stripe? */
  subscription?: boolean;
  /** Pausado POR EL COBRO (al pagar se reactiva). */
  billingPausedAt?: string | null;
}

export interface BillingMockContext {
  role: Role;
  business: MockBillingFields;
  update(changes: Partial<MockBillingFields>): void;
}

const DAY_MS = 86_400_000;
const GRACE_DAYS = 7;
const PLAN_LABELS: Record<Plan, string> = { basic: "Básico", pro: "Pro" };

function ok(data: unknown, status = 200): TransportResponse {
  return { status, payload: { ok: true, data } };
}

function fail(status: number, code: string, error: string): TransportResponse {
  return { status, payload: { ok: false, error, code } };
}

function pauseAtOf(b: MockBillingFields): string | null {
  return b.billingStatus === "past_due" && b.pastDueSince ? new Date(new Date(b.pastDueSince).getTime() + GRACE_DAYS * DAY_MS).toISOString() : null;
}

/** `me.plan.billing` del negocio simulado. */
export function mockPlanBilling(b: MockBillingFields): PlanBilling {
  return {
    trialEndsAt: b.trialEndsAt ?? null,
    currentPeriodEnd: b.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: b.cancelAtPeriodEnd ?? false,
    pastDueSince: b.pastDueSince ?? null,
    pauseAt: pauseAtOf(b),
    onlinePayments: true,
    hasSubscription: b.subscription ?? false,
    canManage: b.stripeCustomer ?? false,
  };
}

function statusOf(b: MockBillingFields, planLabel: string): BillingAccount {
  const billing = mockPlanBilling(b);
  return {
    ...billing,
    plans: (["basic", "pro"] as const).map((id) => ({ id, label: PLAN_LABELS[id], available: true })),
    extras: { locations: true, staff: true },
    plan: b.plan,
    planLabel,
    billingStatus: b.billingStatus,
    paused: b.status === "paused",
    pausedForBilling: b.status === "paused" && Boolean(b.billingPausedAt),
  };
}

/** ¿El negocio está pausado por el cobro? (entonces /billing/* responde igual). */
export function isBillingPaused(b: MockBillingFields): boolean {
  return b.status === "paused" && Boolean(b.billingPausedAt);
}

/** Responde una ruta de /billing/*, o null si no es suya. */
export function routeBillingMock(req: TransportRequest, ctx: BillingMockContext, planLabel: string): TransportResponse | null {
  const path = req.path.split("?")[0];
  if (!path.startsWith("/billing/")) return null;
  if (ctx.role !== "owner") return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
  const b = ctx.business;
  if (b.status === "paused" && !b.billingPausedAt) {
    return fail(403, "business_paused", "La cuenta de este negocio está pausada. Escribinos para reactivarla.");
  }
  const reactivate = isBillingPaused(b) ? { status: "active", billingPausedAt: null } : {};
  const periodEnd = new Date(Date.now() + 30 * DAY_MS).toISOString();

  switch (`${req.method} ${path}`) {
    case "GET /billing/status":
      return ok(statusOf(b, planLabel));

    case "POST /billing/checkout": {
      if (b.subscription) return fail(409, "already_subscribed", "Ya tenés una suscripción activa: cambiá de plan, cupos o tarjeta desde «Gestionar pago».");
      const body = (req.body ?? {}) as { plan?: string };
      if (body.plan !== "basic" && body.plan !== "pro") return fail(400, "validation_error", "Plan inválido.");
      // En prueba, Stripe no cobra hasta que termine: la suscripción queda viva en prueba.
      const inTrial = b.billingStatus === "trial" && b.trialEndsAt && new Date(b.trialEndsAt).getTime() > Date.now();
      ctx.update({
        plan: body.plan,
        billingStatus: inTrial ? "trial" : "active",
        subscription: true,
        stripeCustomer: true,
        currentPeriodEnd: inTrial ? b.trialEndsAt : periodEnd,
        cancelAtPeriodEnd: false,
        pastDueSince: null,
        ...reactivate,
      });
      return ok({ url: "/panel/settings/plan?checkout=success" });
    }

    case "POST /billing/portal": {
      if (!b.stripeCustomer) return fail(409, "no_billing_account", "Todavía no tenés una suscripción en línea: suscribite primero.");
      // Simula que en el Portal actualizó la tarjeta y Stripe cobró lo atrasado.
      if (b.subscription && (b.billingStatus === "past_due" || isBillingPaused(b))) {
        ctx.update({ billingStatus: "active", pastDueSince: null, currentPeriodEnd: periodEnd, ...reactivate });
      }
      return ok({ url: "/panel/settings/plan" });
    }
  }
  return fail(404, "not_found", "Ruta inexistente en el mock.");
}
