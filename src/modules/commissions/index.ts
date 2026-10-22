// API pública del módulo commissions: lo único que otros módulos (y la composición en src/)
// pueden importar de acá (test/architecture/moduleBoundaries.test.ts). Reglas, el
// recálculo sobre lo cobrado (el gancho que la composición inyecta en la agenda y en
// ventas), movimientos, resumen y liquidaciones.
export {
  commissionFor,
  ENTRY_FILTER_STATUSES,
  getCommissionSummary,
  listCommissionEntries,
  recalculateAppointmentCommissions,
} from "./entries";
export type { CommissionEntryView, CommissionSummary, CommissionSummaryRow, EntryFilterStatus, EntryList, ListEntriesFilter } from "./entries";
export { createPayout, deletePayout, getPayout, listPayouts, markPayoutPaid } from "./payouts";
export type { CreatePayoutInput, PayoutView } from "./payouts";
export { commissionsRoutes, type CommissionsRouteDeps } from "./routes";
export { listCommissionRules, resolveRule, RULE_SCOPES } from "./rules";
export type { CommissionRuleView, RuleScope, RuleTarget } from "./rules";
export { COMMISSION_ENTRY_STATUSES, COMMISSION_RULE_KINDS } from "./schema";
export type {
  AppliedCommissionRule,
  CommissionEntry,
  CommissionEntryStatus,
  CommissionRule,
  CommissionRuleKind,
  NewCommissionEntry,
  NewCommissionRule,
  NewPayout,
  Payout,
} from "./schema";
