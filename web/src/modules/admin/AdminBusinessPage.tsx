import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { errorMessage, isApiError } from "../../lib/api";
import type { AdminBusinessDetail, AdminLimitOverrides, AuditEntry, BillingStatus, Plan, PlanChangeInput } from "../../lib/contract";
import { BILLING_STATUS_LABELS, BUSINESS_STATUS_LABELS, monthLabel, MODULES, PLAN_LABELS, PLAN_MODULES, usageText } from "../../lib/plans";
import Dialog from "../../ui/Dialog";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { DayBarChart } from "../reports/charts";
import {
  ADMIN_BUSINESSES_QUERY_KEY,
  adminBusinessQueryKey,
  adminUsageQueryKey,
  changeBusinessPlan,
  getBusinessDetail,
  getBusinessUsage,
  pauseBusiness,
  reactivateBusiness,
} from "./adminApi";
import AdminShell from "./AdminShell";
import "../reports/reports.css";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin › un negocio (/admin/businesses/:id): cobro manual (PROCESO-COBRO-MANUAL.md).
// Cambiar plan (Básico / Pro / Pro sin agente), módulos sueltos, cupos contratados y estado
// del cobro; pausar y reactivar; ver el uso del mes y el historial de cambios. Todo lo
// valida y audita el backend (modules/billing).
// ─────────────────────────────────────────────────────────────────────────────

type LimitKey = keyof AdminLimitOverrides;

const LIMIT_FIELDS: readonly { key: LimitKey; label: string; hint: string; decimals?: boolean }[] = [
  { key: "locations", label: "Sucursales activas", hint: "Cupo contratado." },
  { key: "staff", label: "Profesionales activos", hint: "Cupo contratado." },
  { key: "users", label: "Usuarios del panel", hint: "Incluye invitaciones pendientes." },
  { key: "aiConversations", label: "Conversaciones del agente por mes", hint: "Límite comercial (lo ve el negocio)." },
  { key: "aiLlmUsd", label: "Gasto de LLM por mes (USD)", hint: "Red de seguridad interna; el negocio no lo ve.", decimals: true },
];

const BILLING_OPTIONS = Object.entries(BILLING_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const PLAN_OPTIONS = [
  { value: "basic", label: "Básico" },
  { value: "pro", label: "Pro" },
];

const ACTION_LABELS: Record<string, string> = {
  plan_changed: "Cambio de plan",
  business_paused: "Negocio pausado",
  business_reactivated: "Negocio reactivado",
  business_created: "Alta del negocio",
  member_invited: "Invitación al equipo",
  member_updated: "Cambio en el equipo",
  invitation_accepted: "Invitación aceptada",
  password_changed: "Cambio de clave",
};

interface LimitDraft {
  value: string;
  unlimited: boolean;
}

interface PlanDraft {
  plan: Plan;
  modules: Record<string, boolean>;
  limits: Record<LimitKey, LimitDraft>;
  billingStatus: BillingStatus;
}

function draftOf(detail: AdminBusinessDetail): PlanDraft {
  const plan: Plan = detail.business.plan === "pro" ? "pro" : "basic";
  const enabled = new Set(detail.business.modules);
  const limits = {} as Record<LimitKey, LimitDraft>;
  for (const { key } of LIMIT_FIELDS) {
    const value = detail.overrides.limits[key];
    limits[key] = { value: typeof value === "number" ? String(value) : "", unlimited: value === null };
  }
  return {
    plan,
    modules: Object.fromEntries(MODULES.map((m) => [m.id, enabled.has(m.id)])),
    limits,
    billingStatus: (detail.business.billingStatus as BillingStatus) ?? "trial",
  };
}

const planModules = (plan: Plan) => Object.fromEntries(MODULES.map((m) => [m.id, PLAN_MODULES[plan].includes(m.id)]));

/** Lo que se manda: módulos que difieren del plan y cupos cargados (vacío = el del plan). */
function inputOf(draft: PlanDraft): { input: PlanChangeInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const extraModules: Record<string, boolean> = {};
  for (const m of MODULES) {
    const on = draft.modules[m.id] ?? false;
    if (on !== PLAN_MODULES[draft.plan].includes(m.id)) extraModules[m.id] = on;
  }
  const limits: AdminLimitOverrides = {};
  for (const { key, decimals } of LIMIT_FIELDS) {
    const { value, unlimited } = draft.limits[key];
    if (unlimited) {
      limits[key] = null;
      continue;
    }
    if (!value.trim()) continue;
    const n = Number(value.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || (!decimals && !Number.isInteger(n))) errors[key] = decimals ? "Escribí un monto (0 o más)." : "Escribí un número entero (0 o más).";
    else limits[key] = n;
  }
  return { input: { plan: draft.plan, extraModules, limits, billingStatus: draft.billingStatus }, errors };
}

/** Placeholder del cupo: el valor del plan cuando no hay nada contratado. */
function planPlaceholder(detail: AdminBusinessDetail, key: LimitKey): string {
  if (detail.overrides.limits[key] !== undefined) return "Del plan";
  const current = detail.limits[key];
  return current === null ? "Del plan (sin tope)" : `Del plan (${current})`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("es-CR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function auditSummary(entry: AuditEntry): string | null {
  const d = entry.details as Record<string, unknown>;
  if (entry.action === "plan_changed") {
    const before = d.before as { plan?: string; billingStatus?: string } | undefined;
    const after = d.after as { plan?: string; billingStatus?: string } | undefined;
    const parts: string[] = [];
    if (before?.plan !== after?.plan) parts.push(`${PLAN_LABELS[before?.plan ?? ""] ?? before?.plan} → ${PLAN_LABELS[after?.plan ?? ""] ?? after?.plan}`);
    if (before?.billingStatus !== after?.billingStatus) {
      parts.push(`cobro: ${BILLING_STATUS_LABELS[after?.billingStatus ?? ""] ?? after?.billingStatus}`);
    }
    return parts.join(" · ") || "Módulos o cupos";
  }
  if (entry.action === "business_paused") {
    if (d.reason === "grace_expired") return "Por falta de pago: se cumplió la gracia";
    return typeof d.reason === "string" && d.reason ? `Motivo: ${d.reason}` : null;
  }
  if (entry.action === "business_reactivated" && d.reason === "payment_received") return "Al recibir el pago";
  return null;
}

// ── Plan y cobro ──

function PlanCard({ detail }: { detail: AdminBusinessDetail }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<PlanDraft>(() => draftOf(detail));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const id = detail.business.id;

  const mutation = useMutation({
    mutationFn: (input: PlanChangeInput) => changeBusinessPlan(id, input),
    onSuccess: (next) => {
      qc.setQueryData(adminBusinessQueryKey(id), next);
      void qc.invalidateQueries({ queryKey: ADMIN_BUSINESSES_QUERY_KEY });
      setDraft(draftOf(next));
      showToast(`Listo: «${next.business.name}» quedó en ${next.business.planLabel}.`);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const { input, errors } = inputOf(draft);
    setLocalErrors(errors);
    if (Object.keys(errors).length === 0) mutation.mutate(input);
  }

  const setPlan = (plan: Plan, withoutAgent = false) =>
    setDraft((d) => ({ ...d, plan, modules: { ...planModules(plan), ...(withoutAgent ? { whatsapp: false } : {}) } }));
  const setLimit = (key: LimitKey, change: Partial<LimitDraft>) =>
    setDraft((d) => ({ ...d, limits: { ...d.limits, [key]: { ...d.limits[key], ...change } } }));
  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const limitError = (key: LimitKey) => localErrors[key] ?? apiError?.fieldError(`limits.${key}`);

  return (
    <form className="card admin-plan-form" onSubmit={onSubmit} noValidate aria-labelledby="plan-form-title">
      <h2 id="plan-form-title" className="card-title">
        Plan y cobro
      </h2>
      <div className="form-grid">
        <SelectField label="Plan" value={draft.plan} options={PLAN_OPTIONS} onChange={(e) => setPlan(e.target.value as Plan)} />
        <SelectField
          label="Estado del cobro"
          value={draft.billingStatus}
          options={BILLING_OPTIONS}
          onChange={(e) => setDraft((d) => ({ ...d, billingStatus: e.target.value as BillingStatus }))}
        />
      </div>
      <p className="field-hint">
        <button type="button" className="link-button" onClick={() => setPlan("pro", true)}>
          Pro sin agente
        </button>{" "}
        = Pro con WhatsApp IA apagado (los recordatorios siguen).
      </p>

      <fieldset className="field">
        <legend className="field-label">Módulos (marcá o desmarcá para sumar o quitar sueltos)</legend>
        <div className="admin-module-grid">
          {MODULES.map((m) => {
            const inPlan = PLAN_MODULES[draft.plan].includes(m.id);
            const on = draft.modules[m.id] ?? false;
            return (
              <label key={m.id} className="check-row">
                <input type="checkbox" checked={on} onChange={(e) => setDraft((d) => ({ ...d, modules: { ...d.modules, [m.id]: e.target.checked } }))} />
                <span>
                  {m.label}
                  <small>{on === inPlan ? (inPlan ? "Del plan" : "No incluido") : on ? "Extra contratado" : "Apagado"}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">Cupos contratados (vacío = el del plan)</legend>
        <div className="admin-limit-grid">
          {LIMIT_FIELDS.map((f) => (
            <div key={f.key} className="admin-limit">
              <TextField
                label={f.label}
                inputMode={f.decimals ? "decimal" : "numeric"}
                placeholder={draft.limits[f.key].unlimited ? "Sin tope" : planPlaceholder(detail, f.key)}
                value={draft.limits[f.key].unlimited ? "" : draft.limits[f.key].value}
                disabled={draft.limits[f.key].unlimited}
                hint={f.hint}
                error={limitError(f.key)}
                onChange={(e) => setLimit(f.key, { value: e.target.value })}
              />
              <label className="check-row">
                <input type="checkbox" checked={draft.limits[f.key].unlimited} onChange={(e) => setLimit(f.key, { unlimited: e.target.checked })} />
                <span>Sin tope</span>
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <FormError message={mutation.isError ? errorMessage(mutation.error) : Object.keys(localErrors).length > 0 ? "Revisá los cupos marcados." : null} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setDraft(draftOf(detail))} disabled={mutation.isPending}>
          Descartar
        </button>
        <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar plan"}
        </button>
      </div>
    </form>
  );
}

// ── Servicio: pausar y reactivar ──

function ServiceCard({ detail }: { detail: AdminBusinessDetail }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const { business } = detail;
  const paused = business.status === "paused";

  const onDone = (next: AdminBusinessDetail, message: string) => {
    qc.setQueryData(adminBusinessQueryKey(business.id), next);
    void qc.invalidateQueries({ queryKey: ADMIN_BUSINESSES_QUERY_KEY });
    setConfirming(false);
    setReason("");
    showToast(message);
  };
  const pause = useMutation({
    mutationFn: () => pauseBusiness(business.id, reason.trim() || undefined),
    onSuccess: (next) => onDone(next, `«${business.name}» quedó pausado.`),
  });
  const reactivate = useMutation({
    mutationFn: () => reactivateBusiness(business.id),
    onSuccess: (next) => onDone(next, `«${business.name}» volvió a estar activo.`),
  });

  return (
    <section className="card" aria-labelledby="service-title">
      <h2 id="service-title" className="card-title">
        Servicio
      </h2>
      <p className="admin-service-status">
        <span className={"badge" + (paused ? " badge-warning" : "")}>{BUSINESS_STATUS_LABELS[business.status] ?? business.status}</span>
        {paused
          ? detail.pausedForBilling
            ? "Pausado por falta de pago: la dueña puede entrar solo a pagar y, al pagar, se reactiva solo. Los datos están intactos."
            : "El panel del negocio muestra «Cuenta pausada» y la cola no procesa su trabajo nuevo. Los datos están intactos."
          : detail.pausesAt
            ? `El cobro no está al día: si nadie paga, se pausa solo el ${formatDateTime(detail.pausesAt)}.`
            : "El negocio atiende con normalidad."}
      </p>
      <FormError message={reactivate.isError ? errorMessage(reactivate.error) : null} />
      {business.status === "active" && (
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
          <Icon id="lock" size={16} />
          Pausar negocio
        </button>
      )}
      {paused && (
        <button type="button" className="btn btn-primary" onClick={() => reactivate.mutate()} disabled={reactivate.isPending}>
          <Icon id="refresh" size={16} />
          {reactivate.isPending ? "Reactivando…" : "Reactivar negocio"}
        </button>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={`¿Pausar «${business.name}»?`}>
        <p className="settings-help">
          Mientras esté pausado, el equipo ve «Cuenta pausada», el agente no responde y no salen recordatorios. Nada se borra: al
          reactivarlo, todo vuelve como estaba.
        </p>
        <TextField label="Motivo (opcional)" placeholder="Ej.: falta de pago de octubre" maxLength={200} hint="Queda en el historial. Sin datos personales." value={reason} onChange={(e) => setReason(e.target.value)} />
        <FormError message={pause.isError ? errorMessage(pause.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
            Cancelar
          </button>
          <button type="button" className="btn btn-danger" onClick={() => pause.mutate()} disabled={pause.isPending}>
            {pause.isPending ? "Pausando…" : "Pausar"}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

// ── Uso e historial ──

function UsageCard({ detail }: { detail: AdminBusinessDetail }) {
  const { usage, limits } = detail;
  const rows: [string, number | null, number | null][] = [
    ["Sucursales activas", usage.locations, limits.locations],
    ["Profesionales activos", usage.staff, limits.staff],
    ["Usuarios del panel", usage.users, limits.users],
    ["Conversaciones del agente", usage.aiConversations, limits.aiConversations],
  ];
  return (
    <section className="card" aria-labelledby="usage-title">
      <h2 id="usage-title" className="card-title">
        Uso de {monthLabel(usage.month)}
      </h2>
      <dl className="admin-usage">
        {rows.map(([label, used, limit]) => (
          <div key={label} className="admin-usage-row">
            <dt>{label}</dt>
            <dd className="tnum">{used === null ? "Sin medir" : usageText(used, limit)}</dd>
          </div>
        ))}
        <div className="admin-usage-row">
          <dt>Nivel de clientes</dt>
          <dd>{detail.clientsTier === "full" ? "CRM completo" : "Ficha básica"}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Uso de los últimos 30 días desde `daily_usage` (métricas de producto, I5). */
function ProductUsageCard({ businessId }: { businessId: string }) {
  const query = useQuery({ queryKey: adminUsageQueryKey(businessId, {}), queryFn: () => getBusinessUsage(businessId) });
  return (
    <section className="card" aria-labelledby="product-usage-title">
      <h2 id="product-usage-title" className="card-title">
        Actividad de los últimos 30 días
      </h2>
      {query.isPending ? (
        <p className="muted" role="status">
          Cargando actividad…
        </p>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar la actividad.")} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <dl className="admin-usage">
            {(
              [
                ["Citas creadas", query.data.totals.appointmentsCreated],
                ["Pagos registrados", query.data.totals.paymentsRecorded],
                ["Usuarios activos (días-persona)", query.data.totals.activeUsers],
                ["Logins", query.data.totals.logins],
                ["Conversaciones del agente", query.data.totals.aiConversations],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="admin-usage-row">
                <dt>{label}</dt>
                <dd className="tnum">{value.toLocaleString("es-CR")}</dd>
              </div>
            ))}
            <div className="admin-usage-row">
              <dt>Activado</dt>
              <dd>{query.data.activation.activated ? "Sí" : "Todavía no"}</dd>
            </div>
          </dl>
          <DayBarChart
            data={query.data.daily.map((d) => ({ date: d.date, values: [d.appointmentsCreated] }))}
            series={[{ name: "Citas creadas", tone: "main" }]}
            label={`Citas creadas por día en los últimos 30 días: ${query.data.totals.appointmentsCreated}`}
            format={(v) => v.toLocaleString("es-CR")}
            height={160}
          />
        </>
      )}
    </section>
  );
}

function HistoryCard({ audit }: { audit: AuditEntry[] }) {
  return (
    <section className="card" aria-labelledby="history-title">
      <h2 id="history-title" className="card-title">
        Historial
      </h2>
      {audit.length === 0 ? (
        <p className="muted">Sin cambios registrados todavía.</p>
      ) : (
        <ul className="admin-history">
          {audit.map((e) => (
            <li key={e.id}>
              <span className="admin-history-action">{ACTION_LABELS[e.action] ?? e.action}</span>
              <span className="admin-history-meta tnum">
                {formatDateTime(e.createdAt)} · {e.actor.startsWith("superadmin:") ? "Superadmin" : "Equipo del negocio"}
              </span>
              {auditSummary(e) && <span className="admin-history-detail">{auditSummary(e)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Superadmin › un negocio: plan, cobro, pausa, uso e historial. */
export default function AdminBusinessPage() {
  const { id = "" } = useParams();
  const query = useQuery({ queryKey: adminBusinessQueryKey(id), queryFn: () => getBusinessDetail(id), enabled: Boolean(id) });
  const name = query.data?.business.name ?? "Negocio";

  return (
    <AdminShell title={`${name} · Superadmin`}>
      <Link className="link admin-back" to="/admin">
        ← Negocios
      </Link>
      {query.isPending ? (
        <p className="muted" role="status">
          Cargando negocio…
        </p>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar el negocio.")} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <h1 className="page-title">{query.data.business.name}</h1>
          <p className="admin-business-sub">
            <span className="badge">{query.data.business.planLabel}</span>
            <span>{query.data.business.slug}</span>
            <span>Cobro: {BILLING_STATUS_LABELS[query.data.business.billingStatus] ?? query.data.business.billingStatus}</span>
          </p>
          <div className="admin-grid">
            <PlanCard key={`${query.data.business.plan}-${JSON.stringify(query.data.overrides)}-${query.data.business.billingStatus}`} detail={query.data} />
            <div className="stack">
              <ServiceCard detail={query.data} />
              <UsageCard detail={query.data} />
              <ProductUsageCard businessId={query.data.business.id} />
              <HistoryCard audit={query.data.audit} />
            </div>
          </div>
        </>
      )}
    </AdminShell>
  );
}
