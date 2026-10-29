import type { PlanResource } from "./contract";

// ─────────────────────────────────────────────────────────────────────────────
// Textos de los planes (PLAN-GESTION.md §5) que comparten Configuración › Plan, los avisos
// de cupo y el superadmin. Los nombres de módulo son los del backend (src/modules/billing).
// ─────────────────────────────────────────────────────────────────────────────

/** Módulos en el orden del catálogo, con su nombre para mostrar. */
export const MODULES: readonly { id: string; label: string }[] = [
  { id: "scheduling", label: "Agenda y recordatorios" },
  { id: "clients", label: "Clientes" },
  { id: "sales", label: "Ventas y cobros" },
  { id: "commissions", label: "Comisiones" },
  { id: "reports", label: "Reportes" },
  { id: "whatsapp", label: "WhatsApp IA" },
  { id: "campaigns", label: "Campañas" },
];

/** Módulos que trae cada plan sin extras (espejo de PLANS en src/modules/billing/catalog.ts). */
export const PLAN_MODULES: Readonly<Record<string, readonly string[]>> = {
  basic: ["scheduling", "clients", "whatsapp"],
  pro: MODULES.map((m) => m.id),
};

export const PLAN_LABELS: Readonly<Record<string, string>> = { basic: "Básico", pro: "Pro" };

export function moduleLabel(id: string): string {
  return MODULES.find((m) => m.id === id)?.label ?? id;
}

/** Estado del cobro manual. */
export const BILLING_STATUS_LABELS: Readonly<Record<string, string>> = {
  trial: "En prueba",
  active: "Al día",
  past_due: "Pago pendiente",
  cancelled: "Cancelado",
};

/** Estado del servicio del negocio. */
export const BUSINESS_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "Activo",
  paused: "Pausado",
  closed: "Dado de baja",
};

/** Nombre de cada recurso con cupo, en singular y plural. */
export const RESOURCE_LABELS: Readonly<Record<PlanResource, [string, string]>> = {
  locations: ["sucursal activa", "sucursales activas"],
  staff: ["profesional activo", "profesionales activos"],
  users: ["usuario", "usuarios"],
};

/** "1 de 3", o "2 · sin tope". */
export function usageText(used: number, limit: number | null): string {
  return limit === null ? `${used} · sin tope` : `${used} de ${limit}`;
}

/** ¿Ya no entra uno más? */
export function atLimit(used: number, limit: number | null): boolean {
  return limit !== null && used >= limit;
}

/** "octubre de 2026" a partir de `YYYY-MM`. */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 15)).toLocaleDateString("es-CR", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Días que le quedan a la prueba gratis (redondeado hacia arriba; 0 = vence hoy o ya venció). null sin fecha. */
export function trialDaysLeft(trialEndsAt: string | null | undefined, now = new Date()): number | null {
  if (!trialEndsAt) return null;
  const ms = Date.parse(trialEndsAt) - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** "La cuenta se pausa el 5 de noviembre": fin de la gracia por falta de pago (null si no hay fecha válida). */
export function pausesAtText(pausesAt: string | null | undefined): string | null {
  if (!pausesAt) return null;
  const date = new Date(pausesAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Si no se resuelve, la cuenta se pausa el ${date.toLocaleDateString("es-CR", { day: "numeric", month: "long" })}`;
}

/** "Tu prueba gratis termina hoy / mañana / en 5 días". */
export function trialEndsText(days: number): string {
  if (days <= 0) return "Tu prueba gratis termina hoy";
  if (days === 1) return "Tu prueba gratis termina mañana";
  return `Tu prueba gratis termina en ${days} días`;
}
