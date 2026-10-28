import type { Executor } from "../../platform/db/scope";
import { route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { getUserContact } from "../team";
import { CheckoutInput, getBillingStatus, openPortal, startCheckout, type BillingDeps } from "./checkout";

// ─────────────────────────────────────────────────────────────────────────────
// API del cobro en línea para el dueño (Configuración › Plan y la pantalla de cuenta
// pausada). Solo el dueño; se aceptan con el negocio pausado (`allowWhenPaused`): si la
// pausa es por el cobro, puede pagar y se reactiva solo; si es del superadmin, 403.
//
//   GET  /billing/status     plan, cobro, prueba, período, atraso y qué puede hacer
//   POST /billing/checkout   { plan, extraLocations?, extraStaff? } → { url } de Stripe Checkout
//   POST /billing/portal     → { url } del Customer Portal de Stripe
//
// Sin Stripe configurado: 503 `billing_not_configured` (el cobro sigue siendo manual).
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingRouteDeps extends BillingDeps {
  db: Executor;
}

export function billingRoutes({ db, ...deps }: BillingRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/billing/status", auth: "user", roles: ["owner"], allowWhenPaused: true }, ({ session }) =>
      getBillingStatus(db, session.businessId, deps),
    ),

    route(
      { method: "POST", path: "/billing/checkout", auth: "user", roles: ["owner"], allowWhenPaused: true, body: CheckoutInput, maxBodyBytes: 4 * 1024 },
      async ({ session, body, log }) => {
        const ownerEmail = (await getUserContact(db, session.userId))?.email ?? null;
        const result = await startCheckout(db, { businessId: session.businessId, ownerEmail, ...body }, deps);
        log.info("billing_checkout_started", { plan: body.plan });
        return result;
      },
    ),

    route({ method: "POST", path: "/billing/portal", auth: "user", roles: ["owner"], allowWhenPaused: true }, ({ session }) =>
      openPortal(db, session.businessId, deps),
    ),
  ];
}
