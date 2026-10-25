import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { SETTINGS_KEYS, settingsApi } from "../settings/settingsApi";
import { useGrowthSettings, whatsappApi, whatsappKeys, type GrowthSettings, type GrowthSettingsBody, type UpsellRule } from "./whatsappApi";
import { AGENT_MANAGERS } from "./WhatsappLayout";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp IA › Crecimiento (/whatsapp/growth, dueño y admin): lo que el agente hace para
// traer más citas (I6). Tres tarjetas que se guardan por separado (`PATCH /whatsapp/growth`
// reemplaza cada sección entera):
//   • Reseñas: después de cada cita completada, "¿Cómo te fue?"; Excelente → link de reseñas.
//   • Rescate de cotizaciones: a quien preguntó un precio y no agendó, hasta dos toques.
//   • Sugerencias al agendar (upsell): "a quien agenda X, ofrecele Y".
// Lo que el plan no trae va con candado ("Disponible en el plan Pro"). Sin la plantilla de
// Meta correspondiente, fuera de la ventana de 24 h no se puede escribir: se avisa.
// ─────────────────────────────────────────────────────────────────────────────

export default function GrowthPage() {
  const me = useSession();
  if (!AGENT_MANAGERS.includes(me.role)) return <Navigate to="/whatsapp" replace />;
  return <GrowthContent />;
}

function GrowthContent() {
  const query = useGrowthSettings();
  if (query.isPending) {
    return (
      <div className="clients-loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Cargando la configuración de crecimiento…</span>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState message={errorMessage(query.error, "No pudimos cargar la configuración de crecimiento.")} onRetry={() => void query.refetch()} />;
  }
  const data = query.data;
  return (
    <div className="wa-settings wa-growth">
      <p className="settings-help">
        Lo que el agente hace por su cuenta para que vuelvan y agenden más. Cada función se activa acá; mientras esté apagada, no le escribe a nadie.
      </p>
      <ReviewsCard key={`r${JSON.stringify(data.reviews)}`} data={data} />
      <QuotesCard key={`q${JSON.stringify(data.quoteRecovery)}`} data={data} />
      <UpsellCard key={`u${JSON.stringify(data.upsell)}`} data={data} />
    </div>
  );
}

/** Guarda una sección y deja la respuesta en la caché. */
function useSaveSection(onSaved: string) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  return useMutation({
    mutationFn: (patch: Partial<GrowthSettingsBody>) => whatsappApi.saveGrowth(patch),
    onSuccess: (saved) => {
      if (saved) qc.setQueryData(whatsappKeys.growth, saved);
      else void qc.invalidateQueries({ queryKey: whatsappKeys.growth });
      showToast(onSaved);
    },
  });
}

function Card({ id, title, description, locked, children }: { id: string; title: string; description: string; locked: boolean; children: ReactNode }) {
  return (
    <section className={"card wa-settings-card wa-growth-card" + (locked ? " locked" : "")} aria-labelledby={id}>
      <div className="wa-card-head">
        <div>
          <h2 id={id} className="card-title">
            {title}
          </h2>
          <p className="settings-help">{description}</p>
        </div>
        {locked && (
          <span className="badge badge-muted wa-growth-lock">
            <Icon id="lock" size={14} /> Disponible en el plan Pro
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="readonly-notice">
      <Icon id="alert" size={16} />
      <span>{children}</span>
    </div>
  );
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small className="muted"> {hint}</small>}
      </span>
    </label>
  );
}

function hoursValue(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function SaveRow({ dirty, pending, error, onReset }: { dirty: boolean; pending: boolean; error: unknown; onReset: () => void }) {
  const message = error && !(isApiError(error) && Object.keys(error.fields).length > 0) ? errorMessage(error, "No pudimos guardar los cambios.") : null;
  return (
    <>
      <FormError message={message} />
      <div className="wa-channel-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onReset} disabled={!dirty || pending}>
          Descartar
        </button>
        <button type="submit" className="btn btn-primary btn-small" disabled={!dirty || pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </>
  );
}

function ReviewsCard({ data }: { data: GrowthSettings }) {
  const me = useSession();
  const t = terminologyOf(me);
  const locked = !data.allowed.reviews;
  const initial = { enabled: data.reviews.enabled, delayHours: String(data.reviews.delayHours), reviewUrl: data.reviews.reviewUrl ?? "" };
  const [draft, setDraft] = useState(initial);
  const save = useSaveSection("Guardamos el seguimiento post-servicio.");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const err = (name: string) => (isApiError(save.error) ? save.error.fieldError(`reviews.${name}`) : undefined);
  return (
    <Card
      id="wa-growth-reviews"
      title="Reseñas"
      description={`Unas horas después de cada ${t.appointment} completada, el agente pregunta «¿Cómo te fue?». Si responden «Excelente», les pasa el link para dejar una reseña en Google; si responden «Mal», la conversación pasa a una persona y te avisamos.`}
      locked={locked}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ reviews: { enabled: draft.enabled, delayHours: hoursValue(draft.delayHours), reviewUrl: draft.reviewUrl.trim() || null } });
        }}
      >
        <Toggle label="Pedir la opinión después de cada cita" checked={draft.enabled} disabled={locked} onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
        <div className="form-grid">
          <TextField
            label="Horas después de terminar"
            type="number"
            min={1}
            max={72}
            inputMode="numeric"
            disabled={locked}
            value={draft.delayHours}
            onChange={(e) => setDraft((d) => ({ ...d, delayHours: e.target.value }))}
            error={err("delayHours")}
          />
          <TextField
            label="Link para dejar una reseña"
            hint="El de «Escribir una reseña» de tu perfil de Google. Sin link, se pide la opinión pero no la reseña."
            type="url"
            placeholder="https://g.page/r/…/review"
            disabled={locked}
            value={draft.reviewUrl}
            onChange={(e) => setDraft((d) => ({ ...d, reviewUrl: e.target.value }))}
            error={err("reviewUrl")}
          />
        </div>
        {!locked && !data.templates.followUp && (
          <Notice>
            Falta la plantilla de seguimiento post-servicio en tus números: sin ella, solo le llega a quien te escribió en las últimas 24 horas (fuera de
            la ventana de 24 h no se puede escribir sin plantilla). Cargala en WhatsApp IA › Configuración › Números.
          </Notice>
        )}
        {!locked && <SaveRow dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(initial)} />}
      </form>
    </Card>
  );
}

function QuotesCard({ data }: { data: GrowthSettings }) {
  const locked = !data.allowed.quoteRecovery;
  const initial = { enabled: data.quoteRecovery.enabled, waitHours: String(data.quoteRecovery.waitHours), firstTouchText: data.quoteRecovery.firstTouchText ?? "" };
  const [draft, setDraft] = useState(initial);
  const save = useSaveSection("Guardamos el rescate de cotizaciones.");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const err = (name: string) => (isApiError(save.error) ? save.error.fieldError(`quoteRecovery.${name}`) : undefined);
  const textId = useId();
  return (
    <Card
      id="wa-growth-quotes"
      title="Rescate de cotizaciones"
      description="Cuando alguien pregunta un precio y no agenda, el agente le vuelve a escribir: primero con los próximos horarios libres y, un día después, con la plantilla de rescate. Si agenda, cuenta como recuperada."
      locked={locked}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ quoteRecovery: { enabled: draft.enabled, waitHours: hoursValue(draft.waitHours), firstTouchText: draft.firstTouchText.trim() || null } });
        }}
      >
        <Toggle label="Rescatar las cotizaciones que no se agendaron" checked={draft.enabled} disabled={locked} onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
        <TextField
          label="Horas de espera antes del primer mensaje"
          type="number"
          min={1}
          max={72}
          inputMode="numeric"
          disabled={locked}
          value={draft.waitHours}
          onChange={(e) => setDraft((d) => ({ ...d, waitHours: e.target.value }))}
          error={err("waitHours")}
        />
        <div className="field">
          <label htmlFor={textId} className="field-label">
            Primer mensaje (opcional)
          </label>
          <textarea
            id={textId}
            className="input wa-textarea"
            rows={3}
            maxLength={500}
            disabled={locked}
            placeholder="¡Hola! Hace un rato consultaste por {servicio} ({monto}). ¿Querés que te lo agende?"
            value={draft.firstTouchText}
            onChange={(e) => setDraft((d) => ({ ...d, firstTouchText: e.target.value }))}
            aria-describedby={`${textId}-hint`}
          />
          <p id={`${textId}-hint`} className={err("firstTouchText") ? "field-error" : "field-hint"}>
            {err("firstTouchText") ?? "Vacío = el mensaje de siempre. Podés usar {servicio} y {monto}."}
          </p>
        </div>
        {!locked && !data.templates.quoteRecovery && (
          <Notice>
            Falta la plantilla de rescate de cotizaciones en tus números: sin ella no hay segundo mensaje (fuera de la ventana de 24 h no se puede escribir sin
            plantilla).
          </Notice>
        )}
        {!locked && <SaveRow dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(initial)} />}
      </form>
    </Card>
  );
}

function UpsellCard({ data }: { data: GrowthSettings }) {
  const me = useSession();
  const t = terminologyOf(me);
  const locked = !data.allowed.upsell;
  const catalog = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog, staleTime: 60_000, enabled: !locked });
  const initial = { enabled: data.upsell.enabled, rules: data.upsell.rules };
  const [draft, setDraft] = useState<{ enabled: boolean; rules: UpsellRule[] }>(initial);
  const save = useSaveSection("Guardamos las sugerencias al agendar.");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const err = (name: string) => (isApiError(save.error) ? save.error.fieldError(`upsell.${name}`) : undefined);
  const services = (catalog.data?.services ?? []).filter((s) => s.active || draft.rules.some((r) => r.serviceId === s.id || r.suggestServiceId === s.id));
  const options = [{ value: "", label: "Elegí un servicio" }, ...services.map((s) => ({ value: s.id, label: s.name }))];
  const setRule = (i: number, change: Partial<UpsellRule>) => setDraft((d) => ({ ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...change } : r)) }));
  return (
    <Card
      id="wa-growth-upsell"
      title="Sugerencias al agendar"
      description={`Cuando el agente agenda una ${t.appointment}, ofrece una sola vez agregar un servicio que va bien con ese (con la misma persona y a continuación). Si no le interesa, no se lo vuelve a ofrecer por dos meses.`}
      locked={locked}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ upsell: { enabled: draft.enabled, rules: draft.rules.filter((r) => r.serviceId || r.suggestServiceId) } });
        }}
      >
        <Toggle label="Ofrecer un servicio complementario al agendar" checked={draft.enabled} disabled={locked} onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
        {!locked && catalog.isError && <FormError message={errorMessage(catalog.error, "No pudimos cargar los servicios.")} />}
        <ul className="wa-upsell-rules" aria-label="Reglas de sugerencia">
          {draft.rules.map((rule, i) => (
            <li key={i} className="wa-upsell-rule">
              <SelectField
                label={`A quien agenda (regla ${i + 1})`}
                options={options}
                value={rule.serviceId}
                disabled={locked}
                onChange={(e) => setRule(i, { serviceId: e.target.value })}
                error={err(`rules.${i}.serviceId`)}
              />
              <SelectField
                label="Ofrecerle"
                options={options}
                value={rule.suggestServiceId}
                disabled={locked}
                onChange={(e) => setRule(i, { suggestServiceId: e.target.value })}
                error={err(`rules.${i}.suggestServiceId`)}
              />
              {!locked && (
                <button
                  type="button"
                  className="btn btn-ghost btn-small wa-upsell-remove"
                  aria-label={`Quitar la regla ${i + 1}`}
                  onClick={() => setDraft((d) => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }))}
                >
                  <Icon id="trash" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {draft.rules.length === 0 && <p className="muted wa-empty-note">Todavía no hay reglas. Ej.: a quien agenda Manicura, ofrecerle Pedicura.</p>}
        {!locked && (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setDraft((d) => ({ ...d, rules: [...d.rules, { serviceId: "", suggestServiceId: "" }] }))}
            disabled={draft.rules.length >= 30}
          >
            <Icon id="plus" size={16} /> Agregar regla
          </button>
        )}
        {!locked && <SaveRow dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(initial)} />}
      </form>
    </Card>
  );
}
