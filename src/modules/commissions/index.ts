// API pública del módulo commissions: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I4.
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
