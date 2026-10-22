import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { hasPgCode, PG_UNIQUE_VIOLATION } from "../../platform/db/errors";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getCatalog } from "../catalog";
import { getStaffMember } from "../team";
import { COMMISSION_RULE_KINDS, commissionRules, type AppliedCommissionRule, type CommissionRule, type CommissionRuleKind } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Reglas de comisión (Ventas › Comisiones, plan Pro). Una regla tiene un ALCANCE y un
// valor; para cada línea de servicio gana la más específica (PLAN-GESTION.md §4):
//
//   1. profesional + servicio      (staffId + serviceId)
//   2. servicio                    (serviceId)
//   3. categoría del servicio      (categoryId)
//   4. profesional                 (staffId)
//   5. general del negocio         (todo en null)
//
// `percent`: `value` en puntos básicos (1500 = 15 %, tope 10000). `fixed`: céntimos por
// línea (prorrateados por lo cobrado de la línea, ver ./entries.ts). Una regla por alcance
// (la base lo frena: 409 `duplicate_rule`). El alcance no se edita: se borra y se crea
// otra. Una regla inactiva no se aplica. Cambiar o borrar una regla no reescribe lo ya
// calculado: cada movimiento guarda la copia de la regla con la que nació.
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_SCOPES = ["staff_service", "service", "category", "staff", "general"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export interface CommissionRuleView {
  id: string;
  scope: RuleScope;
  staffId: string | null;
  serviceId: string | null;
  categoryId: string | null;
  kind: CommissionRuleKind;
  value: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Tope de un monto fijo por línea (igual que los precios del catálogo). */
const MAX_FIXED_CENTS = 100_000_000_000;

function checkValue(kind: CommissionRuleKind, value: number, ctx: z.RefinementCtx): void {
  if (kind === "percent" && value > 10_000) ctx.addIssue({ code: "custom", path: ["value"], message: "El porcentaje va de 0 a 100 % (0 a 10000 puntos básicos)." });
}

const Value = z.int("El valor tiene que ser un entero.").min(0, "El valor no puede ser negativo.").max(MAX_FIXED_CENTS);

export const NewCommissionRuleInput = z
  .object({
    staffId: z.uuid().nullable().default(null),
    serviceId: z.uuid().nullable().default(null),
    categoryId: z.uuid().nullable().default(null),
    kind: z.enum(COMMISSION_RULE_KINDS),
    value: Value,
    active: z.boolean().default(true),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.serviceId && r.categoryId) ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Elegí un servicio o una categoría, no los dos." });
    if (r.staffId && r.categoryId) ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Por profesional, la regla puede ser general o de un servicio (no de una categoría)." });
    checkValue(r.kind, r.value, ctx);
  });

export const CommissionRulePatch = z
  .object({ kind: z.enum(COMMISSION_RULE_KINDS), value: Value, active: z.boolean() })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

const notFound = () => new HttpError(404, "Esa regla de comisión no existe.", "not_found");
const duplicateRule = () => new HttpError(409, "Ya hay una regla para ese alcance: editala en vez de crear otra.", "duplicate_rule");

export function scopeOf(rule: Pick<CommissionRule, "staffId" | "serviceId" | "categoryId">): RuleScope {
  if (rule.staffId && rule.serviceId) return "staff_service";
  if (rule.serviceId) return "service";
  if (rule.categoryId) return "category";
  if (rule.staffId) return "staff";
  return "general";
}

function toView(r: CommissionRule): CommissionRuleView {
  return {
    id: r.id,
    scope: scopeOf(r),
    staffId: r.staffId,
    serviceId: r.serviceId,
    categoryId: r.categoryId,
    kind: r.kind as CommissionRuleKind,
    value: r.value,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const SCOPE_ORDER: Record<RuleScope, number> = { staff_service: 0, service: 1, category: 2, staff: 3, general: 4 };

/** Reglas del negocio, de la más específica a la general. */
export async function listCommissionRules(executor: Executor, businessId: string, options: { activeOnly?: boolean } = {}): Promise<CommissionRuleView[]> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(commissionRules)
      .where(options.activeOnly ? and(eq(commissionRules.businessId, businessId), eq(commissionRules.active, true)) : eq(commissionRules.businessId, businessId))
      .orderBy(asc(commissionRules.createdAt)),
  );
  return rows.map(toView).sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
}

/** Lo que identifica a una línea para elegir su regla. */
export interface RuleTarget {
  staffId: string;
  serviceId: string | null;
  categoryId: string | null;
}

/** La regla más específica que aplica (entre las ACTIVAS), o null si no hay ninguna. */
export function resolveRule(rules: readonly CommissionRuleView[], target: RuleTarget): CommissionRuleView | null {
  const active = rules.filter((r) => r.active);
  const find = (match: (r: CommissionRuleView) => boolean) => active.find(match) ?? null;
  const { staffId, serviceId, categoryId } = target;
  return (
    (serviceId ? find((r) => r.scope === "staff_service" && r.staffId === staffId && r.serviceId === serviceId) : null) ??
    (serviceId ? find((r) => r.scope === "service" && r.serviceId === serviceId) : null) ??
    (categoryId ? find((r) => r.scope === "category" && r.categoryId === categoryId) : null) ??
    find((r) => r.scope === "staff" && r.staffId === staffId) ??
    find((r) => r.scope === "general")
  );
}

/** Copia de la regla que se guarda en el movimiento. */
export function appliedRule(rule: CommissionRuleView): AppliedCommissionRule {
  return { ruleId: rule.id, kind: rule.kind, value: rule.value };
}

/** Valida que el profesional, el servicio y la categoría sean del negocio. */
async function assertScopeOfBusiness(executor: Executor, businessId: string, input: { staffId: string | null; serviceId: string | null; categoryId: string | null }): Promise<void> {
  const fields: Record<string, string> = {};
  if (input.staffId && !(await getStaffMember(executor, businessId, input.staffId))) fields["body.staffId"] = "Ese profesional no existe.";
  if (input.serviceId || input.categoryId) {
    const catalog = await getCatalog(executor, businessId);
    if (input.serviceId && !catalog.services.some((s) => s.id === input.serviceId)) fields["body.serviceId"] = "Ese servicio no existe.";
    if (input.categoryId && !catalog.categories.some((c) => c.id === input.categoryId)) fields["body.categoryId"] = "Esa categoría no existe.";
  }
  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
}

async function record(tx: Tx, session: Session, entityId: string, snapshot: unknown): Promise<void> {
  await recordConfigChange(tx, { businessId: session.businessId, entity: "commission_rule", entityId, snapshot, changedBy: session.userId });
}

export async function createCommissionRule(db: Executor, session: Session, input: z.output<typeof NewCommissionRuleInput>): Promise<CommissionRuleView> {
  const { businessId } = session;
  const scope = {
    staffId: input.staffId?.toLowerCase() ?? null,
    serviceId: input.serviceId?.toLowerCase() ?? null,
    categoryId: input.categoryId?.toLowerCase() ?? null,
  };
  await assertScopeOfBusiness(db, businessId, scope);
  try {
    return await withTenant(db, businessId, async (tx) => {
      const [row] = await tx
        .insert(commissionRules)
        .values({ businessId, ...scope, kind: input.kind, value: input.value, active: input.active })
        .returning();
      const view = toView(row);
      await record(tx, session, view.id, view);
      return view;
    });
  } catch (error) {
    if (hasPgCode(error, PG_UNIQUE_VIOLATION)) throw duplicateRule();
    throw error;
  }
}

export async function updateCommissionRule(
  db: Executor,
  session: Session,
  ruleId: string,
  patch: z.output<typeof CommissionRulePatch>,
): Promise<CommissionRuleView> {
  const { businessId } = session;
  return withTenant(db, businessId, async (tx) => {
    const [current] = await tx
      .select()
      .from(commissionRules)
      .where(and(eq(commissionRules.businessId, businessId), eq(commissionRules.id, ruleId)))
      .for("update");
    if (!current) throw notFound();
    const kind = patch.kind ?? (current.kind as CommissionRuleKind);
    const value = patch.value ?? current.value;
    if (kind === "percent" && value > 10_000) throw new ValidationError({ "body.value": "El porcentaje va de 0 a 100 % (0 a 10000 puntos básicos)." });
    const [row] = await tx.update(commissionRules).set(patch).where(eq(commissionRules.id, current.id)).returning();
    const view = toView(row);
    await record(tx, session, view.id, view);
    return view;
  });
}

export async function deleteCommissionRule(db: Executor, session: Session, ruleId: string): Promise<void> {
  const { businessId } = session;
  await withTenant(db, businessId, async (tx) => {
    const [row] = await tx
      .delete(commissionRules)
      .where(and(eq(commissionRules.businessId, businessId), eq(commissionRules.id, ruleId)))
      .returning();
    if (!row) throw notFound();
    await record(tx, session, row.id, { ...toView(row), deleted: true });
  });
}
