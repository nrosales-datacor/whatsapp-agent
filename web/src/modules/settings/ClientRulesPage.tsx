import { useState, type FormEvent } from "react";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { centsToInput, currencySymbol, parseAmountToCents } from "../../lib/money";
import ErrorState from "../../ui/ErrorState";
import { FormError, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { useClientRules, useSaveClientRules, type ClientRulesView, type ClientStatusRules } from "../clients/crmApi";
import { CheckRow, fieldErrorOf, LoadingState } from "./common";
import "../clients/clients.css";

// Configuración › Reglas de clientes (plan Pro): los umbrales del estado del cliente
// (nuevo, VIP, en riesgo, inactivo). El estado no se guarda: se calcula con las visitas y
// el gasto de cada cliente y estas reglas, así un cambio se ve al toque en la lista.

interface Draft {
  newDays: string;
  vipByVisits: boolean;
  vipMinVisits: string;
  vipBySpend: boolean;
  vipMinSpent: string;
  atRiskMode: "fixed" | "frequency";
  atRiskAfterDays: string;
  atRiskFrequencyFactor: string;
  inactiveAfterDays: string;
}

function toDraft(r: ClientStatusRules): Draft {
  return {
    newDays: String(r.newDays),
    vipByVisits: r.vipMinVisits !== null,
    vipMinVisits: String(r.vipMinVisits ?? 10),
    vipBySpend: r.vipMinSpentCents !== null,
    vipMinSpent: r.vipMinSpentCents !== null ? centsToInput(r.vipMinSpentCents) : "",
    atRiskMode: r.atRiskMode,
    atRiskAfterDays: String(r.atRiskAfterDays),
    atRiskFrequencyFactor: String(r.atRiskFrequencyFactor).replace(".", ","),
    inactiveAfterDays: String(r.inactiveAfterDays),
  };
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

/** Borrador → reglas, o los errores por campo. */
function fromDraft(d: Draft): { rules: ClientStatusRules | null; errors: Partial<Record<keyof Draft, string>> } {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const newDays = int(d.newDays);
  if (!(newDays >= 1 && newDays <= 365)) errors.newDays = "Entre 1 y 365 días.";
  const vipMinVisits = d.vipByVisits ? int(d.vipMinVisits) : null;
  if (vipMinVisits !== null && !(vipMinVisits >= 1)) errors.vipMinVisits = "Escribí la cantidad de visitas.";
  const vipMinSpentCents = d.vipBySpend ? parseAmountToCents(d.vipMinSpent) : null;
  if (d.vipBySpend && vipMinSpentCents === null) errors.vipMinSpent = "Escribí un monto.";
  const atRiskAfterDays = int(d.atRiskAfterDays);
  if (!(atRiskAfterDays >= 1 && atRiskAfterDays <= 3650)) errors.atRiskAfterDays = "Entre 1 y 3650 días.";
  const factor = Number(d.atRiskFrequencyFactor.replace(",", "."));
  if (!(factor >= 1 && factor <= 10)) errors.atRiskFrequencyFactor = "Entre 1 y 10 veces.";
  const inactiveAfterDays = int(d.inactiveAfterDays);
  if (!(inactiveAfterDays >= 1 && inactiveAfterDays <= 3650)) errors.inactiveAfterDays = "Entre 1 y 3650 días.";
  else if (!errors.atRiskAfterDays && inactiveAfterDays <= atRiskAfterDays) errors.inactiveAfterDays = "Tienen que ser más días que los de «en riesgo».";
  if (Object.keys(errors).length > 0) return { rules: null, errors };
  return {
    rules: {
      newDays,
      vipMinVisits,
      vipMinSpentCents,
      atRiskMode: d.atRiskMode,
      atRiskAfterDays,
      atRiskFrequencyFactor: Math.round(factor * 10) / 10,
      inactiveAfterDays,
    },
    errors,
  };
}

export default function ClientRulesPage() {
  const me = useSession();
  const query = useClientRules(me.business.id);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={errorMessage(query.error, "No pudimos cargar las reglas.")} onRetry={() => void query.refetch()} />;
  return <RulesForm key={JSON.stringify(query.data.rules)} view={query.data} />;
}

function RulesForm({ view }: { view: ClientRulesView }) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const save = useSaveClientRules(me.business.id);
  const [draft, setDraft] = useState<Draft>(() => toDraft(view.rules));
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const symbol = currencySymbol(me.business.currency);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    if (save.isError) save.reset();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const { rules, errors: found } = fromDraft(draft);
    setErrors(found);
    if (!rules) return;
    save.mutate(rules, { onSuccess: () => showToast("Reglas guardadas: los estados ya se calculan con las nuevas.") });
  }

  const errorOf = (key: keyof Draft, apiKey: string = key) => errors[key] ?? fieldErrorOf(save.error, apiKey);

  return (
    <form className="settings-form crm-rules" onSubmit={onSubmit} noValidate aria-label={`Reglas de ${t.clients}`}>
      <section className="card">
        <h3 className="card-title">Nuevo</h3>
        <TextField
          label="Días como nuevo"
          inputMode="numeric"
          value={draft.newDays}
          hint={`Desde su primera visita (o desde que se cargó, si todavía no vino).`}
          error={errorOf("newDays")}
          onChange={(e) => set("newDays", e.target.value)}
        />
      </section>

      <section className="card">
        <h3 className="card-title">VIP</h3>
        <p className="settings-help">Además de los que marques a mano en la ficha. Alcanza con cumplir uno de los dos.</p>
        <CheckRow label="Por cantidad de visitas" checked={draft.vipByVisits} onChange={(v) => set("vipByVisits", v)} />
        {draft.vipByVisits && (
          <TextField label="Visitas para ser VIP" inputMode="numeric" value={draft.vipMinVisits} error={errorOf("vipMinVisits")} onChange={(e) => set("vipMinVisits", e.target.value)} />
        )}
        <CheckRow label="Por gasto total" checked={draft.vipBySpend} onChange={(v) => set("vipBySpend", v)} />
        {draft.vipBySpend && (
          <TextField
            label={`Gasto total para ser VIP (${symbol})`}
            inputMode="decimal"
            value={draft.vipMinSpent}
            error={errorOf("vipMinSpent", "vipMinSpentCents")}
            onChange={(e) => set("vipMinSpent", e.target.value)}
          />
        )}
      </section>

      <section className="card">
        <h3 className="card-title">En riesgo</h3>
        <fieldset className="field">
          <legend>¿Cuándo está en riesgo?</legend>
          <label className="check-row">
            <input type="radio" name="atRiskMode" checked={draft.atRiskMode === "fixed"} onChange={() => set("atRiskMode", "fixed")} />
            <span>
              Después de una cantidad fija de días sin volver
              <small>Igual para todos.</small>
            </span>
          </label>
          <label className="check-row">
            <input type="radio" name="atRiskMode" checked={draft.atRiskMode === "frequency"} onChange={() => set("atRiskMode", "frequency")} />
            <span>
              Según su frecuencia
              <small>Quien viene cada 3 semanas está en riesgo antes que quien viene cada 6 meses.</small>
            </span>
          </label>
        </fieldset>
        {draft.atRiskMode === "frequency" && (
          <TextField
            label="Veces su intervalo promedio entre visitas"
            inputMode="decimal"
            value={draft.atRiskFrequencyFactor}
            hint="Con 2: si viene cada 20 días, está en riesgo a los 40 sin volver."
            error={errorOf("atRiskFrequencyFactor")}
            onChange={(e) => set("atRiskFrequencyFactor", e.target.value)}
          />
        )}
        <TextField
          label="Días sin volver"
          inputMode="numeric"
          value={draft.atRiskAfterDays}
          hint={draft.atRiskMode === "frequency" ? `Para quien tiene menos de dos visitas (todavía no hay frecuencia).` : undefined}
          error={errorOf("atRiskAfterDays")}
          onChange={(e) => set("atRiskAfterDays", e.target.value)}
        />
      </section>

      <section className="card">
        <h3 className="card-title">Inactivo</h3>
        <TextField
          label="Días sin volver para inactivo"
          inputMode="numeric"
          value={draft.inactiveAfterDays}
          error={errorOf("inactiveAfterDays")}
          onChange={(e) => set("inactiveAfterDays", e.target.value)}
        />
      </section>

      <FormError message={save.isError ? (isApiError(save.error) && Object.keys(save.error.fields).length > 0 ? "Revisá los campos marcados." : errorMessage(save.error)) : null} />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setDraft(toDraft(view.industryDefaults));
            setErrors({});
          }}
        >
          Restaurar las del rubro
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? "Guardando…" : "Guardar reglas"}
        </button>
      </div>
    </form>
  );
}
