import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Appointment } from "../scheduling/schedulingApi";
import { scheduleKeys } from "../scheduling/schedulingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de Ventas y Comisiones (I4) y sus llamadas. Escrito a mano, espejo de:
//   src/modules/sales/{paymentMethods,payments,routes}.ts        /settings/payment-methods, /appointments/:id/payments|balance, /sales/*
//   src/modules/commissions/{rules,entries,payouts,routes}.ts     /settings/commission-rules, /commissions/*
// Si el backend cambia la forma, cambia acá y en ./salesMock.ts. Montos en céntimos;
// fechas de los filtros en días locales (AAAA-MM-DD, inclusive).
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentKind = "deposit" | "payment" | "refund";
export type ChargeKind = Exclude<PaymentKind, "refund">;

export interface PaymentMethod {
  id: string;
  name: string;
  active: boolean;
  position: number;
}

export type DeletePaymentMethodResult = { deleted: true } | { deleted: false; method: PaymentMethod };

export interface Payment {
  id: string;
  kind: PaymentKind;
  amountCents: number;
  paidAt: string;
  method: { id: string; name: string } | null;
  locationId: string;
  location: { id: string; name: string } | null;
  clientId: string;
  client: { id: string; name: string } | null;
  appointmentId: string | null;
  refundOfId: string | null;
  refundedCents: number;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
}

export interface CollectedSums {
  depositsCents: number;
  paymentsCents: number;
  refundsCents: number;
}

export interface AppointmentBalance extends CollectedSums {
  appointmentId: string;
  status: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  payments: Payment[];
}

export interface PaymentTotals extends CollectedSums {
  collectedCents: number;
  netCents: number;
  count: number;
}

export interface PaymentList {
  items: Payment[];
  totals: PaymentTotals;
  truncated: boolean;
}

export interface PendingItem {
  appointment: Appointment;
  paidCents: number;
  balanceCents: number;
}

export interface PendingList {
  items: PendingItem[];
  count: number;
  balanceCents: number;
}

export interface MethodSummary extends CollectedSums {
  methodId: string;
  name: string;
  active: boolean;
  netCents: number;
  count: number;
}

export interface DailySummary {
  date: string;
  timezone: string;
  currency: string;
  locationId: string | null;
  byMethod: MethodSummary[];
  totals: PaymentTotals;
}

export interface AppointmentChargeInput {
  kind: ChargeKind;
  amountCents: number;
  methodId: string;
  note?: string | null;
}

export interface ClientChargeInput extends AppointmentChargeInput {
  clientId: string;
  locationId: string;
}

export interface RefundInput {
  amountCents: number;
  reason: string;
  methodId?: string;
}

export interface PaymentFilters {
  from?: string;
  to?: string;
  methodId?: string;
  kind?: PaymentKind;
  clientId?: string;
}

// ── Comisiones ──────────────────────────────────────────────────────────────

export type RuleScope = "staff_service" | "service" | "category" | "staff" | "general";
export type RuleKind = "percent" | "fixed";

export interface CommissionRule {
  id: string;
  scope: RuleScope;
  staffId: string | null;
  serviceId: string | null;
  categoryId: string | null;
  kind: RuleKind;
  /** percent: puntos básicos (1500 = 15 %); fixed: céntimos por línea. */
  value: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommissionRuleInput {
  staffId: string | null;
  serviceId: string | null;
  categoryId: string | null;
  kind: RuleKind;
  value: number;
  active?: boolean;
}

export type EntryStatusFilter = "open" | "in_payout" | "paid";

export interface CommissionEntry {
  id: string;
  staffId: string;
  staff: { id: string; name: string; color: string | null } | null;
  appointmentId: string;
  appointmentServiceId: string;
  locationId: string;
  earnedAt: string;
  appointmentStartsAt: string | null;
  serviceName: string | null;
  clientName: string | null;
  baseCents: number;
  amountCents: number;
  rule: { ruleId: string | null; kind: RuleKind; value: number };
  status: "pending" | "paid";
  payoutId: string | null;
  adjustment: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EntryList {
  items: CommissionEntry[];
  totalCents: number;
  count: number;
  truncated: boolean;
}

export interface CommissionSummaryRow {
  staffId: string;
  name: string;
  color: string | null;
  count: number;
  baseCents: number;
  amountCents: number;
  openCents: number;
  inPayoutCents: number;
  paidCents: number;
}

export interface CommissionSummary {
  rows: CommissionSummaryRow[];
  totals: Omit<CommissionSummaryRow, "staffId" | "name" | "color">;
}

export interface Payout {
  id: string;
  staffId: string;
  staff: { id: string; name: string; color: string | null } | null;
  periodStart: string;
  periodEnd: string;
  totalCents: number;
  entryCount: number;
  paidAt: string | null;
  paidBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface PayoutInput {
  staffId: string;
  periodStart: string;
  periodEnd: string;
  note?: string | null;
}

export interface EntryFilters {
  from?: string;
  to?: string;
  staffId?: string;
  status?: EntryStatusFilter;
  payoutId?: string;
}

// ── Claves de query ─────────────────────────────────────────────────────────

export const salesKeys = {
  all: ["sales"] as const,
  methods: ["sales", "methods"] as const,
  balance: (appointmentId: string) => ["sales", "balance", appointmentId] as const,
  payments: (f: PaymentFilters) => ["sales", "payments", f.from ?? "", f.to ?? "", f.methodId ?? "", f.kind ?? "", f.clientId ?? ""] as const,
  pending: (from: string, to: string) => ["sales", "pending", from, to] as const,
  summary: (date: string) => ["sales", "summary", date] as const,
  rules: ["sales", "commission-rules"] as const,
  entries: (f: EntryFilters) => ["sales", "commission-entries", f.from ?? "", f.to ?? "", f.staffId ?? "", f.status ?? "", f.payoutId ?? ""] as const,
  commissionSummary: (from: string, to: string) => ["sales", "commission-summary", from, to] as const,
  payouts: ["sales", "payouts"] as const,
};

const enc = encodeURIComponent;

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const salesApi = {
  listMethods: () => api.get<PaymentMethod[]>("/settings/payment-methods"),
  createMethod: (name: string) => api.post<PaymentMethod>("/settings/payment-methods", { name }),
  updateMethod: (id: string, patch: { name?: string; active?: boolean }) => api.patch<PaymentMethod>(`/settings/payment-methods/${enc(id)}`, patch),
  reorderMethods: (ids: string[]) => api.put<PaymentMethod[]>("/settings/payment-methods/order", { ids }),
  deleteMethod: (id: string) => api.delete<DeletePaymentMethodResult>(`/settings/payment-methods/${enc(id)}`),

  balance: (appointmentId: string) => api.get<AppointmentBalance>(`/appointments/${enc(appointmentId)}/balance`),
  chargeAppointment: (appointmentId: string, input: AppointmentChargeInput) =>
    api.post<{ payment: Payment; balance: AppointmentBalance }>(`/appointments/${enc(appointmentId)}/payments`, input),
  chargeClient: (input: ClientChargeInput) => api.post<Payment>("/sales/payments", input),
  refund: (paymentId: string, input: RefundInput) => api.post<{ refund: Payment; original: Payment }>(`/sales/payments/${enc(paymentId)}/refund`, input),
  listPayments: (f: PaymentFilters) => api.get<PaymentList>(`/sales/payments${query({ ...f })}`),
  pending: (from: string, to: string) => api.get<PendingList>(`/sales/pending${query({ from, to })}`),
  summary: (date: string) => api.get<DailySummary>(`/sales/summary${query({ date })}`),

  listRules: () => api.get<CommissionRule[]>("/settings/commission-rules"),
  createRule: (input: CommissionRuleInput) => api.post<CommissionRule>("/settings/commission-rules", input),
  updateRule: (id: string, patch: { kind?: RuleKind; value?: number; active?: boolean }) => api.patch<CommissionRule>(`/settings/commission-rules/${enc(id)}`, patch),
  deleteRule: (id: string) => api.delete<void>(`/settings/commission-rules/${enc(id)}`),
  entries: (f: EntryFilters) => api.get<EntryList>(`/commissions/entries${query({ ...f })}`),
  commissionSummary: (from: string, to: string) => api.get<CommissionSummary>(`/commissions/summary${query({ from, to })}`),
  payouts: () => api.get<Payout[]>("/commissions/payouts"),
  createPayout: (input: PayoutInput) => api.post<Payout>("/commissions/payouts", input),
  markPayoutPaid: (id: string) => api.post<Payout>(`/commissions/payouts/${enc(id)}/paid`),
  deletePayout: (id: string) => api.delete<void>(`/commissions/payouts/${enc(id)}`),
};

// ── Hooks ───────────────────────────────────────────────────────────────────

export function usePaymentMethods(enabled = true) {
  return useQuery({ queryKey: salesKeys.methods, queryFn: salesApi.listMethods, staleTime: 60_000, enabled });
}

export function useAppointmentBalance(appointmentId: string | null, enabled = true) {
  return useQuery({
    queryKey: salesKeys.balance(appointmentId ?? ""),
    queryFn: () => salesApi.balance(appointmentId as string),
    enabled: Boolean(appointmentId) && enabled,
  });
}

/** Después de cobrar o devolver: todo lo de Ventas (y la agenda, que muestra saldos) se refresca. */
export function useSalesInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: salesKeys.all });
    void qc.invalidateQueries({ queryKey: scheduleKeys.all });
  };
}

export function useChargeAppointment(appointmentId: string) {
  const invalidate = useSalesInvalidation();
  return useMutation({ mutationFn: (input: AppointmentChargeInput) => salesApi.chargeAppointment(appointmentId, input), onSuccess: invalidate });
}
