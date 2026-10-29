import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import type { Terminology } from "../../lib/contract";
import { centsToInput, currencySymbol, formatCents, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { formatShortDate, todayIn } from "../scheduling/format";
import { CheckRow, ConfirmDialog } from "../settings/common";
import { SETTINGS_KEYS, settingsApi } from "../settings/settingsApi";
import { isoToZoned } from "../settings/zonedTime";
import { formatPercent, monthStart, parsePercent, ruleTargetLabel, ruleValueLabel, scopeLabel } from "./format";
import { Kpi } from "./PaymentsPage";
import {
  salesApi,
  salesKeys,
  type CommissionEntry,
  type CommissionRule,
  type CommissionSummaryRow,
  type EntryStatusFilter,
  type Payout,
  type RuleKind,
  type RuleScope,
} from "./salesApi";

// ─────────────────────────────────────────────────────────────────────────────
// Ventas › Comisiones (dueño y admin) y "Mis comisiones" (profesional). Sobre lo cobrado:
// el backend las calcula al completar y con cada cobro o devolución.
//   • Resumen del período por profesional: ganado, sin liquidar, en liquidación, pagado.
//   • Movimientos (por línea de servicio), con filtro por profesional y estado.
//   • Liquidaciones: liquidar lo pendiente de un profesional, marcarla pagada o anularla.
//   • Reglas (dueño y admin): por profesional, servicio, categoría o general.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: "" | EntryStatusFilter; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "open", label: "Sin liquidar" },
  { value: "in_payout", label: "En liquidación" },
  { value: "paid", label: "Pagados" },
];

function useCommissionsInvalidation() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: salesKeys.all });
}

function entryState(e: CommissionEntry): string {
  if (e.status === "paid") return "Pagado";
  return e.payoutId ? "En liquidación" : "Sin liquidar";
}

export default function CommissionsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const isStaff = me.role === "staff";
  const today = todayIn(me.business.timezone);
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [staffFilter, setStaffFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | EntryStatusFilter>("");
  const [liquidating, setLiquidating] = useState<CommissionSummaryRow | null>(null);
  const validRange = Boolean(from && to && from <= to);

  const summary = useQuery({ queryKey: salesKeys.commissionSummary(from, to), queryFn: () => salesApi.commissionSummary(from, to), enabled: validRange });
  const entryFilters = { from, to, staffId: staffFilter || undefined, status: statusFilter || undefined };
  const entries = useQuery({ queryKey: salesKeys.entries(entryFilters), queryFn: () => salesApi.entries(entryFilters), enabled: validRange, placeholderData: (p) => p });
  const payouts = useQuery({ queryKey: salesKeys.payouts, queryFn: salesApi.payouts });

  const rows = summary.data?.rows ?? [];
  const totals = summary.data?.totals;

  return (
    <div className="stack">
      <div className="sales-toolbar">
        <TextField label="Desde" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Hasta" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {!validRange && <p className="field-error">La fecha «Hasta» tiene que ser igual o posterior a «Desde».</p>}

      {totals && (
        <div className="sales-kpis" aria-label="Comisiones del período">
          <Kpi label={isStaff ? "Ganado en el período" : "Comisiones del período"} value={formatCents(totals.amountCents, currency)} hint={`sobre ${formatCents(totals.baseCents, currency)} cobrados`} strong />
          <Kpi label="Sin liquidar" value={formatCents(totals.openCents, currency)} />
          <Kpi label="En liquidación" value={formatCents(totals.inPayoutCents, currency)} />
          <Kpi label="Pagado" value={formatCents(totals.paidCents, currency)} />
        </div>
      )}

      {!isStaff && (
        <section className="card" aria-labelledby="commissions-by-staff">
          <h2 id="commissions-by-staff" className="card-title">
            Por {t.staffMember}
          </h2>
          {summary.isPending ? (
            <p className="muted">Cargando…</p>
          ) : summary.isError ? (
            <ErrorState message={errorMessage(summary.error, "No pudimos cargar el resumen.")} onRetry={() => void summary.refetch()} />
          ) : rows.length === 0 ? (
            <p className="muted">Sin comisiones en el período. Se calculan sobre lo cobrado de las {t.appointments} completadas, según las reglas de abajo.</p>
          ) : (
            <div className="sales-table-scroll">
              <table className="sales-table" aria-label={`Comisiones por ${t.staffMember}`}>
                <thead>
                  <tr>
                    <th scope="col">{capitalize(t.staffMember)}</th>
                    <th scope="col" className="sales-col-num">
                      Ganado
                    </th>
                    <th scope="col" className="sales-col-num">
                      Sin liquidar
                    </th>
                    <th scope="col" className="sales-col-num">
                      Pagado
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.staffId}>
                      <th scope="row">
                        <span className="staff-dot" style={{ background: r.color ?? "var(--accent)" }} aria-hidden="true" /> {r.name}
                      </th>
                      <td className="sales-col-num tnum">{formatCents(r.amountCents, currency)}</td>
                      <td className="sales-col-num tnum">{formatCents(r.openCents, currency)}</td>
                      <td className="sales-col-num tnum">{formatCents(r.paidCents, currency)}</td>
                      <td className="sales-col-action">
                        {r.openCents > 0 && (
                          <button type="button" className="btn btn-secondary btn-small" onClick={() => setLiquidating(r)}>
                            Liquidar<span className="visually-hidden"> a {r.name}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="commission-entries">
        <h2 id="commission-entries" className="card-title">
          Movimientos
        </h2>
        <div className="sales-toolbar sales-toolbar-inline">
          {!isStaff && (
            <SelectField
              label={capitalize(t.staffMember)}
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              options={[{ value: "", label: "Todos" }, ...rows.map((r) => ({ value: r.staffId, label: r.name }))]}
            />
          )}
          <SelectField label="Estado" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | EntryStatusFilter)} options={STATUS_OPTIONS} />
        </div>
        {entries.isPending ? (
          <p className="muted">Cargando…</p>
        ) : entries.isError ? (
          <p className="field-error">{errorMessage(entries.error, "No pudimos cargar los movimientos.")}</p>
        ) : entries.data.items.length === 0 ? (
          <p className="muted">Sin movimientos con esos filtros.</p>
        ) : (
          <ul className="sales-entries" aria-label="Movimientos de comisión">
            {entries.data.items.map((e) => (
              <li key={e.id} className="sales-entry">
                <div className="sales-entry-main">
                  <p className="sales-entry-title">
                    {e.serviceName ?? "Servicio"} · {e.clientName ?? capitalize(t.client)}
                    {e.adjustment && <span className="badge badge-warning">Ajuste</span>}
                  </p>
                  <p className="muted">
                    {formatShortDate(isoToZoned(e.earnedAt, me.business.timezone).date)}
                    {!isStaff && e.staff ? ` · ${e.staff.name}` : ""} · {ruleValueLabel(e.rule, currency)} sobre {formatCents(e.baseCents, currency)} · {entryState(e)}
                  </p>
                </div>
                <span className={"tnum sales-strong" + (e.amountCents < 0 ? " sales-negative" : "")}>{formatCents(e.amountCents, currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {entries.data?.truncated && <p className="muted">Se muestran los más recientes: acotá las fechas para ver el resto.</p>}
      </section>

      <PayoutsSection payouts={payouts.data ?? []} loading={payouts.isPending} error={payouts.isError ? payouts.error : null} canManage={!isStaff} />

      {!isStaff && <RulesSection />}

      {liquidating && <PayoutDialog row={liquidating} defaultStart={from} defaultEnd={to} onClose={() => setLiquidating(null)} />}
    </div>
  );
}

// ── Liquidaciones ───────────────────────────────────────────────────────────

function PayoutsSection({ payouts, loading, error, canManage }: { payouts: Payout[]; loading: boolean; error: unknown; canManage: boolean }) {
  const me = useSession();
  const currency = me.business.currency;
  const { showToast } = useToast();
  const invalidate = useCommissionsInvalidation();
  const [annulling, setAnnulling] = useState<Payout | null>(null);
  const paid = useMutation({
    mutationFn: salesApi.markPayoutPaid,
    onSuccess: (p) => {
      invalidate();
      showToast(`Liquidación de ${p.staff?.name ?? ""} marcada como pagada.`);
    },
  });
  const annul = useMutation({
    mutationFn: (p: Payout) => salesApi.deletePayout(p.id),
    onSuccess: () => {
      invalidate();
      showToast("Liquidación anulada: sus comisiones vuelven a estar sin liquidar.");
      setAnnulling(null);
    },
  });

  return (
    <section className="card" aria-labelledby="payouts">
      <h2 id="payouts" className="card-title">
        Liquidaciones
      </h2>
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : error ? (
        <p className="field-error">{errorMessage(error, "No pudimos cargar las liquidaciones.")}</p>
      ) : payouts.length === 0 ? (
        <p className="muted">Todavía no hay liquidaciones.</p>
      ) : (
        <ul className="sales-entries" aria-label="Liquidaciones">
          {payouts.map((p) => (
            <li key={p.id} className="sales-entry">
              <div className="sales-entry-main">
                <p className="sales-entry-title">
                  {canManage ? `${p.staff?.name ?? "—"} · ` : ""}
                  {formatShortDate(p.periodStart)} – {formatShortDate(p.periodEnd)}
                  <span className={"badge" + (p.paidAt ? "" : " badge-warning")}>{p.paidAt ? "Pagada" : "Sin pagar"}</span>
                </p>
                <p className="muted">
                  {p.entryCount === 1 ? "1 movimiento" : `${p.entryCount} movimientos`}
                  {p.paidAt ? ` · pagada el ${formatShortDate(isoToZoned(p.paidAt, me.business.timezone).date)}` : ""}
                  {p.note ? ` · ${p.note}` : ""}
                </p>
              </div>
              <span className="tnum sales-strong">{formatCents(p.totalCents, currency)}</span>
              {canManage && !p.paidAt && (
                <div className="sales-entry-actions">
                  <button type="button" className="btn btn-primary btn-small" disabled={paid.isPending} onClick={() => paid.mutate(p.id)}>
                    Marcar pagada<span className="visually-hidden"> la liquidación de {p.staff?.name}</span>
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setAnnulling(p)}>
                    Anular<span className="visually-hidden"> la liquidación de {p.staff?.name}</span>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError message={paid.isError ? errorMessage(paid.error) : null} />
      {annulling && (
        <ConfirmDialog
          open
          title="¿Anular la liquidación?"
          confirmLabel="Anular"
          danger
          pending={annul.isPending}
          error={annul.isError ? errorMessage(annul.error) : null}
          onConfirm={() => annul.mutate(annulling)}
          onClose={() => setAnnulling(null)}
        >
          <p>
            Sus comisiones ({formatCents(annulling.totalCents, currency)}) vuelven a quedar sin liquidar y se recalculan con lo cobrado hoy.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PayoutDialog({ row, defaultStart, defaultEnd, onClose }: { row: CommissionSummaryRow; defaultStart: string; defaultEnd: string; onClose: () => void }) {
  const me = useSession();
  const currency = me.business.currency;
  const { showToast } = useToast();
  const invalidate = useCommissionsInvalidation();
  const [periodStart, setPeriodStart] = useState(defaultStart);
  const [periodEnd, setPeriodEnd] = useState(defaultEnd);
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: () => salesApi.createPayout({ staffId: row.staffId, periodStart, periodEnd, note: note.trim() || null }),
    onSuccess: (p) => {
      invalidate();
      showToast(`Liquidación de ${row.name} por ${formatCents(p.totalCents, currency)} creada. Marcala pagada cuando le pagues.`);
      onClose();
    },
  });
  const apiError = isApiError(mutation.error) ? mutation.error : null;
  return (
    <Dialog open onClose={onClose} title={`Liquidar a ${row.name}`}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          mutation.mutate();
        }}
        noValidate
      >
        <p className="settings-help">
          Junta todas sus comisiones sin liquidar hasta el fin del período (también las atrasadas). En este período tiene {formatCents(row.openCents, currency)} sin liquidar.
        </p>
        <div className="form-grid">
          <TextField label="Desde" type="date" value={periodStart} max={periodEnd} onChange={(e) => setPeriodStart(e.target.value)} error={apiError?.fieldError("periodStart")} />
          <TextField label="Hasta" type="date" value={periodEnd} min={periodStart} onChange={(e) => setPeriodEnd(e.target.value)} error={apiError?.fieldError("periodEnd")} />
        </div>
        <TextField label="Nota (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <FormError message={mutation.isError && !apiError?.fieldError("periodEnd") && !apiError?.fieldError("periodStart") ? errorMessage(mutation.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Liquidando…" : "Crear liquidación"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Reglas ──────────────────────────────────────────────────────────────────

function useRuleNames() {
  const staff = useQuery({ queryKey: SETTINGS_KEYS.staff, queryFn: settingsApi.listStaff, staleTime: 60_000 });
  const catalog = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog, staleTime: 60_000 });
  return {
    staff: staff.data ?? [],
    services: catalog.data?.services ?? [],
    categories: catalog.data?.categories ?? [],
    names: {
      staff: new Map((staff.data ?? []).map((s) => [s.id, s.name])),
      services: new Map((catalog.data?.services ?? []).map((s) => [s.id, s.name])),
      categories: new Map((catalog.data?.categories ?? []).map((c) => [c.id, c.name])),
    },
  };
}

function RulesSection() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const rules = useQuery({ queryKey: salesKeys.rules, queryFn: salesApi.listRules });
  const lookup = useRuleNames();
  const [editing, setEditing] = useState<CommissionRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommissionRule | null>(null);
  const { showToast } = useToast();
  const invalidate = useCommissionsInvalidation();
  const remove = useMutation({
    mutationFn: (r: CommissionRule) => salesApi.deleteRule(r.id),
    onSuccess: () => {
      invalidate();
      showToast("Regla eliminada. Lo ya calculado no cambia.");
      setDeleting(null);
    },
  });

  return (
    <section className="card" aria-labelledby="commission-rules">
      <div className="sales-section-head">
        <h2 id="commission-rules" className="card-title">
          Reglas de comisión
        </h2>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing("new")}>
          <Icon id="plus" size={16} />
          Nueva regla
        </button>
      </div>
      <p className="settings-help">
        Para cada servicio gana la regla más específica: {t.staffMember} + servicio → servicio → categoría → {t.staffMember} → general. Cambiar una regla no reescribe lo ya calculado.
      </p>
      {rules.isPending ? (
        <p className="muted">Cargando…</p>
      ) : rules.isError ? (
        <p className="field-error">{errorMessage(rules.error)}</p>
      ) : rules.data.length === 0 ? (
        <EmptyState icon="receipt" title="Sin reglas" help="Sin reglas no se calculan comisiones. Empezá por una general (por ejemplo, 10 % de lo cobrado)." />
      ) : (
        <ul className="settings-list" aria-label="Reglas de comisión">
          {rules.data.map((r) => (
            <li key={r.id} className={"settings-item" + (r.active ? "" : " inactive")}>
              <div className="settings-item-main">
                <span className="settings-item-title">
                  {ruleTargetLabel(r, lookup.names)}
                  {!r.active && <span className="badge badge-muted">Inactiva</span>}
                </span>
                <span className="settings-item-meta">
                  {scopeLabel(r.scope, t)} · {ruleValueLabel(r, currency)}
                </span>
              </div>
              <div className="settings-item-actions">
                <button type="button" className="icon-btn" aria-label={`Editar la regla ${ruleTargetLabel(r, lookup.names)}`} onClick={() => setEditing(r)}>
                  <Icon id="pencil" size={18} />
                </button>
                <button type="button" className="icon-btn danger" aria-label={`Eliminar la regla ${ruleTargetLabel(r, lookup.names)}`} onClick={() => setDeleting(r)}>
                  <Icon id="trash" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog rule={editing === "new" ? null : editing} lookup={lookup} t={t} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          title="¿Eliminar la regla?"
          confirmLabel="Eliminar"
          danger
          pending={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p>Las comisiones ya calculadas con ella se conservan; lo que se cobre de ahora en más usa la regla que quede.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function RuleDialog({ rule, lookup, t, onClose }: { rule: CommissionRule | null; lookup: ReturnType<typeof useRuleNames>; t: Terminology; onClose: () => void }) {
  const me = useSession();
  const currency = me.business.currency;
  const { showToast } = useToast();
  const invalidate = useCommissionsInvalidation();
  const [scope, setScope] = useState<RuleScope>(rule?.scope ?? "general");
  const [staffId, setStaffId] = useState(rule?.staffId ?? lookup.staff[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(rule?.serviceId ?? lookup.services[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(rule?.categoryId ?? lookup.categories[0]?.id ?? "");
  const [kind, setKind] = useState<RuleKind>(rule?.kind ?? "percent");
  const [value, setValue] = useState(rule ? (rule.kind === "percent" ? formatPercent(rule.value) : centsToInput(rule.value)) : "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (parsed: number) => {
      if (rule) return salesApi.updateRule(rule.id, { kind, value: parsed, active });
      const needsStaff = scope === "staff" || scope === "staff_service";
      const needsService = scope === "service" || scope === "staff_service";
      return salesApi.createRule({
        staffId: needsStaff ? staffId : null,
        serviceId: needsService ? serviceId : null,
        categoryId: scope === "category" ? categoryId : null,
        kind,
        value: parsed,
        active,
      });
    },
    onSuccess: () => {
      invalidate();
      showToast(rule ? "Regla guardada." : "Regla creada: se aplica a lo que se cobre de ahora en más.");
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = kind === "percent" ? parsePercent(value) : parseAmountToCents(value);
    if (parsed === null || (kind === "fixed" && parsed <= 0)) return setLocalError(kind === "percent" ? "Escribí un porcentaje entre 0 y 100." : "Escribí un monto mayor que cero.");
    setLocalError(null);
    mutation.mutate(parsed);
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const scopes: RuleScope[] = ["general", "staff", "service", "category", "staff_service"];
  return (
    <Dialog open onClose={onClose} title={rule ? "Editar regla" : "Nueva regla de comisión"}>
      <form onSubmit={onSubmit} noValidate>
        {rule ? (
          <p className="settings-help">
            {scopeLabel(rule.scope, t)}: {ruleTargetLabel(rule, lookup.names)}. El alcance no se cambia: para otro, creá otra regla.
          </p>
        ) : (
          <>
            <SelectField label="Se aplica a" value={scope} onChange={(e) => setScope(e.target.value as RuleScope)} options={scopes.map((s) => ({ value: s, label: scopeLabel(s, t) }))} />
            {(scope === "staff" || scope === "staff_service") && (
              <SelectField label={capitalize(t.staffMember)} value={staffId} onChange={(e) => setStaffId(e.target.value)} options={lookup.staff.map((s) => ({ value: s.id, label: s.name }))} error={apiError?.fieldError("staffId")} />
            )}
            {(scope === "service" || scope === "staff_service") && (
              <SelectField label="Servicio" value={serviceId} onChange={(e) => setServiceId(e.target.value)} options={lookup.services.map((s) => ({ value: s.id, label: s.name }))} error={apiError?.fieldError("serviceId")} />
            )}
            {scope === "category" &&
              (lookup.categories.length === 0 ? (
                <p className="field-error">No hay categorías de servicios: crealas en Configuración › Servicios.</p>
              ) : (
                <SelectField label="Categoría" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} options={lookup.categories.map((c) => ({ value: c.id, label: c.name }))} error={apiError?.fieldError("categoryId")} />
              ))}
          </>
        )}
        <div className="form-grid">
          <SelectField
            label="Tipo"
            value={kind}
            onChange={(e) => setKind(e.target.value as RuleKind)}
            options={[
              { value: "percent", label: "Porcentaje de lo cobrado" },
              { value: "fixed", label: "Monto fijo por servicio" },
            ]}
          />
          <TextField
            label={kind === "percent" ? "Porcentaje (%)" : `Monto (${currencySymbol(currency)})`}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            hint={kind === "fixed" ? "Si el servicio se cobra en parte, se paga la parte proporcional." : undefined}
            error={localError ?? apiError?.fieldError("value")}
          />
        </div>
        <div className="field">
          <CheckRow label="Activa" hint="Una regla inactiva no se aplica." checked={active} onChange={setActive} />
        </div>
        <FormError message={mutation.isError && !apiError?.fieldError("value") ? errorMessage(mutation.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
