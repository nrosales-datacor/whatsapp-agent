import { api } from "../../lib/api";
import type { BillingOption, BillingStatusView } from "../../lib/contract";

// Cobro en línea con Stripe (I6.6), solo el dueño: Configuración › Plan. Checkout y Portal
// devuelven la URL de Stripe; el panel navega ahí (sale del panel y vuelve a
// /settings/plan?billing=ok|cancelled). Lo que cambia el plan es el webhook, no la vuelta.

export const BILLING_STATUS_QUERY_KEY = ["billing", "status"] as const;

export const getBillingStatus = () => api.get<BillingStatusView>("/billing/status");

export const startCheckout = (option: BillingOption) => api.post<{ url: string }>("/billing/checkout", { option });

export const openBillingPortal = () => api.post<{ url: string }>("/billing/portal");
