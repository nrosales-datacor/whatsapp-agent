import { capitalize } from "../../app/navigation";
import type { Terminology } from "../../lib/contract";
import { formatCents } from "../../lib/money";
import type { CommissionRule, PaymentKind, RuleKind, RuleScope } from "./salesApi";

// ─────────────────────────────────────────────────────────────────────────────
// Textos y formatos de Ventas y Comisiones.
// ─────────────────────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<PaymentKind, string> = {
  deposit: "Seña",
  payment: "Cobro",
  refund: "Devolución",
};

/** "Cobro registrado", "Seña registrada", "Devolución registrada". */
export function registeredLabel(kind: PaymentKind): string {
  return kind === "payment" ? "Cobro registrado" : `${KIND_LABEL[kind]} registrada`;
}

export function scopeLabel(scope: RuleScope, t: Terminology): string {
  switch (scope) {
    case "staff_service":
      return `${capitalize(t.staffMember)} + servicio`;
    case "service":
      return "Servicio";
    case "category":
      return "Categoría";
    case "staff":
      return capitalize(t.staffMember);
    case "general":
      return "General del negocio";
  }
}

/** "15 %" o "₡4 000 por servicio". */
export function ruleValueLabel(rule: { kind: RuleKind; value: number }, currency: string): string {
  if (rule.kind === "percent") return `${formatPercent(rule.value)} %`;
  return `${formatCents(rule.value, currency)} por servicio`;
}

/** Puntos básicos → "15" / "12,5". */
export function formatPercent(basisPoints: number): string {
  return (basisPoints / 100).toLocaleString("es-CR", { maximumFractionDigits: 2 });
}

/** "15" / "12,5" / "12.5" → puntos básicos (1250), o null si no es un porcentaje válido (0–100). */
export function parsePercent(text: string): number | null {
  const raw = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
  const bp = Math.round(Number(raw) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Nombre del alcance de una regla con los nombres de profesional, servicio y categoría. */
export function ruleTargetLabel(
  rule: Pick<CommissionRule, "scope" | "staffId" | "serviceId" | "categoryId">,
  names: { staff: Map<string, string>; services: Map<string, string>; categories: Map<string, string> },
): string {
  const staff = rule.staffId ? (names.staff.get(rule.staffId) ?? "—") : "";
  const service = rule.serviceId ? (names.services.get(rule.serviceId) ?? "Servicio borrado") : "";
  const category = rule.categoryId ? (names.categories.get(rule.categoryId) ?? "Categoría borrada") : "";
  switch (rule.scope) {
    case "staff_service":
      return `${staff} · ${service}`;
    case "service":
      return service;
    case "category":
      return category;
    case "staff":
      return staff;
    case "general":
      return "Todos los servicios";
  }
}

/** Primer día del mes de una fecha local ("2026-10-22" → "2026-10-01"). */
export function monthStart(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/** "AAAA-MM-DD" ± n días. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
