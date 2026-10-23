import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { BillingAccount, CheckoutInput } from "../../lib/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Cobro en línea (I6): estado de la suscripción y la salida a Stripe (Checkout para
// suscribirse, Customer Portal para gestionar el pago). Solo el dueño; también con la
// cuenta pausada POR EL COBRO (para poder pagar y reactivarla).
// ─────────────────────────────────────────────────────────────────────────────

export const BILLING_STATUS_QUERY_KEY = ["billing", "status"] as const;

export const getBillingStatus = () => api.get<BillingAccount>("/billing/status");

export const startCheckout = (input: CheckoutInput) => api.post<{ url: string }>("/billing/checkout", input);

export const openPortal = () => api.post<{ url: string }>("/billing/portal");

export function useBillingStatus(enabled = true) {
  return useQuery({ queryKey: BILLING_STATUS_QUERY_KEY, queryFn: getBillingStatus, enabled, staleTime: 30_000 });
}

/** Sale del panel hacia la página de Stripe (Checkout o Portal). */
export function goToStripe(url: string): void {
  window.location.assign(url);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días que faltan hasta `iso` (redondeado hacia arriba; 0 si ya pasó). */
export function daysUntil(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS));
}

/** "12 de noviembre de 2026" (fecha local del navegador). */
export function formatBillingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CR", { day: "numeric", month: "long", year: "numeric" });
}

/** "Te quedan 3 días de prueba" / "Hoy termina tu prueba". */
export function trialLeftText(iso: string): string {
  const days = daysUntil(iso);
  if (days === 0) return "Hoy termina tu prueba gratis";
  return days === 1 ? "Te queda 1 día de prueba gratis" : `Te quedan ${days} días de prueba gratis`;
}
