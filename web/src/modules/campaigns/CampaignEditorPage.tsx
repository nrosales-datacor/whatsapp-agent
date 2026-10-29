import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import { CLIENT_STATUSES, useClientFormOptions, useClientTags, type ClientStatus } from "../clients/clientsApi";
import { STATUS_LABELS as CLIENT_STATUS_LABELS } from "../clients/crmApi";
import { SETTINGS_KEYS, settingsApi } from "../settings/settingsApi";
import {
  campaignsApi,
  MAX_MESSAGE,
  useAudiencePreview,
  useCampaign,
  useCampaignMutation,
  type CampaignDetail,
  type CampaignInput,
  type CampaignSegment,
} from "./campaignsApi";
import { ChannelNotice } from "./CampaignsPage";
import "../settings/settings.css";
import "./campaigns.css";

// ─────────────────────────────────────────────────────────────────────────────
// Editor de una campaña en borrador (/campaigns/new y /campaigns/:id/edit): nombre, mensaje
// (un párrafo: va en la variable {{2}} de la plantilla de marketing) y segmento con los
// filtros del CRM, con la vista previa en vivo de a quiénes les llega y cuántos quedan
// afuera (sin consentimiento, con baja o sin teléfono). Lanzar se hace desde el detalle.
// ─────────────────────────────────────────────────────────────────────────────

interface SegmentDraft {
  statuses: ClientStatus[];
  tags: string[];
  vip: "" | "yes" | "no";
  location: string;
  staff: string;
  minDays: string;
  maxDays: string;
  lapsedService: string;
  lapsedMonths: string;
  excludeUpcoming: boolean;
}

function toDraft(s: CampaignSegment): SegmentDraft {
  return {
    statuses: s.statuses ?? [],
    tags: s.tags ?? [],
    vip: s.vip === true ? "yes" : s.vip === false ? "no" : "",
    location: s.preferredLocationId ?? "",
    staff: s.preferredStaffId ?? "",
    minDays: s.lastVisitMinDays ? String(s.lastVisitMinDays) : "",
    maxDays: s.lastVisitMaxDays ? String(s.lastVisitMaxDays) : "",
    lapsedService: s.lapsedService?.serviceId ?? "",
    lapsedMonths: s.lapsedService ? String(s.lapsedService.months) : "6",
    excludeUpcoming: s.excludeUpcoming !== false,
  };
}

const intOrUndefined = (text: string) => {
  const n = Number(text);
  return text.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
};

function toSegment(d: SegmentDraft): CampaignSegment {
  const segment: CampaignSegment = {};
  if (d.statuses.length) segment.statuses = d.statuses;
  if (d.tags.length) segment.tags = d.tags;
  if (d.vip) segment.vip = d.vip === "yes";
  if (d.location) segment.preferredLocationId = d.location;
  if (d.staff) segment.preferredStaffId = d.staff;
  const min = intOrUndefined(d.minDays);
  const max = intOrUndefined(d.maxDays);
  if (min) segment.lastVisitMinDays = min;
  if (max) segment.lastVisitMaxDays = max;
  const months = intOrUndefined(d.lapsedMonths);
  if (d.lapsedService && months) segment.lapsedService = { serviceId: d.lapsedService, months };
  if (!d.excludeUpcoming) segment.excludeUpcoming = false;
  return segment;
}

/** El mismo valor, pero recién cuando deja de cambiar por `ms` (para no pedir la vista previa en cada tecla). */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function CampaignEditorPage() {
  const { id } = useParams();
  if (!id) return <Editor initial={null} />;
  return <EditExisting id={id} />;
}

function EditExisting({ id }: { id: string }) {
  const query = useCampaign(id);
  if (query.isPending) {
    return (
      <div className="page">
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando la campaña…</span>
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="page">
        <ErrorState message={errorMessage(query.error, "No pudimos cargar la campaña.")} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (query.data.status !== "draft") {
    return (
      <div className="page">
        <PageHeader title={query.data.name} />
        <p>
          Esta campaña ya se lanzó y no se puede cambiar. <Link to={`/campaigns/${id}`}>Ver sus resultados</Link>.
        </p>
      </div>
    );
  }
  return <Editor initial={query.data} />;
}

function Editor({ initial }: { initial: CampaignDetail | null }) {
  const me = useSession();
  const t = terminologyOf(me);
  const navigate = useNavigate();
  const { showToast } = useToast();
  const crm = me.plan.clientsTier === "full";
  const [name, setName] = useState(initial?.name ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [draft, setDraft] = useState<SegmentDraft>(() => toDraft(initial?.segment ?? {}));
  const segment = toSegment(draft);
  // Se compara por texto: el objeto se arma de nuevo en cada render.
  const debouncedKey = useDebounced(JSON.stringify(segment));
  const debounced = useMemo(() => JSON.parse(debouncedKey) as CampaignSegment, [debouncedKey]);
  const preview = useAudiencePreview(debounced);
  const options = useClientFormOptions(me.business.id);
  const tags = useClientTags(me.business.id, crm);
  const catalog = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog, staleTime: 60_000 });
  const messageId = useId();

  const save = useCampaignMutation((input: CampaignInput) => (initial ? campaignsApi.update(initial.id, input) : campaignsApi.create(input)));
  const fieldError = (key: string) => (isApiError(save.error) ? save.error.fieldError(key) : undefined);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      { name: name.trim(), message: message.trim(), segment },
      {
        onSuccess: (saved) => {
          showToast(initial ? "Guardamos el borrador." : "Creamos el borrador. Revisalo y lanzalo cuando quieras.");
          if (saved) navigate(`/campaigns/${saved.id}`);
        },
      },
    );
  }

  const set = <K extends keyof SegmentDraft>(key: K, value: SegmentDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const services = (catalog.data?.services ?? []).filter((s) => s.active);
  const p = preview.data;

  return (
    <div className="page">
      <Link to={initial ? `/campaigns/${initial.id}` : "/campaigns"} className="back-link">
        <Icon id="chevronLeft" size={16} />
        {initial ? "Volver a la campaña" : "Volver a Campañas"}
      </Link>
      <PageHeader title={initial ? "Editar campaña" : "Nueva campaña"} tabTitle={`${initial ? "Editar" : "Nueva"} · Campañas`} />

      <div className="cp-editor">
        <form onSubmit={onSubmit} aria-label="Campaña">
          <section className="card" aria-labelledby="cp-message-title">
            <h2 id="cp-message-title" className="card-title">
              Mensaje
            </h2>
            <TextField label="Nombre de la campaña" hint="Solo lo ves vos." maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={fieldError("name")} />
            <div className="field">
              <div className="field-label-row">
                <label htmlFor={messageId} className="field-label">
                  Mensaje
                </label>
              </div>
              <textarea
                id={messageId}
                className="input cp-message"
                maxLength={MAX_MESSAGE}
                value={message}
                // Va en una variable de la plantilla: Meta no acepta saltos de línea ni tabs.
                onChange={(e) => setMessage(e.target.value.replace(/[\r\n\t]+/g, " "))}
                aria-describedby={`${messageId}-hint`}
                aria-invalid={fieldError("message") ? true : undefined}
              />
              <p id={`${messageId}-hint`} className={fieldError("message") ? "field-error" : "field-hint"}>
                {fieldError("message") ??
                  `Un solo párrafo. Le llega dentro de tu plantilla de marketing, con el nombre del ${t.client} al principio y la opción de darse de baja.`}
              </p>
              <p className="cp-counter tnum" aria-live="polite">
                {message.length} / {MAX_MESSAGE}
              </p>
            </div>
          </section>

          <section className="card" aria-labelledby="cp-segment-title">
            <h2 id="cp-segment-title" className="card-title">
              A quiénes
            </h2>
            <p className="settings-help">Todo se combina: tienen que cumplir cada filtro que elijas. Sin filtros, les llega a todos los que aceptaron promociones.</p>

            <fieldset className="field">
              <legend className="field-label">Estado</legend>
              <div className="cp-chips">
                {CLIENT_STATUSES.map((s) => (
                  <button key={s} type="button" className="cp-chip" aria-pressed={draft.statuses.includes(s)} onClick={() => set("statuses", toggle(draft.statuses, s))}>
                    {CLIENT_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </fieldset>

            {crm && (tags.data?.length ?? 0) > 0 && (
              <fieldset className="field">
                <legend className="field-label">Etiquetas</legend>
                <div className="cp-chips">
                  {tags.data!.map(({ tag }) => (
                    <button key={tag} type="button" className="cp-chip" aria-pressed={draft.tags.includes(tag)} onClick={() => set("tags", toggle(draft.tags, tag))}>
                      {tag}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="form-grid">
              <TextField
                label="Última visita hace al menos (días)"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="Ej.: 60"
                value={draft.minDays}
                onChange={(e) => set("minDays", e.target.value)}
                error={fieldError("segment.lastVisitMinDays")}
              />
              <TextField
                label="Última visita hace como mucho (días)"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="Ej.: 365"
                value={draft.maxDays}
                onChange={(e) => set("maxDays", e.target.value)}
                error={fieldError("segment.lastVisitMaxDays")}
              />
              <SelectField
                label="VIP"
                options={[
                  { value: "", label: "Todos" },
                  { value: "yes", label: "Solo VIP" },
                  { value: "no", label: "Sin los VIP" },
                ]}
                value={draft.vip}
                onChange={(e) => set("vip", e.target.value as SegmentDraft["vip"])}
              />
              <SelectField
                label={`${capitalize(t.location)} preferida`}
                options={[{ value: "", label: "Cualquiera" }, ...(options.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))]}
                value={draft.location}
                onChange={(e) => set("location", e.target.value)}
              />
              <SelectField
                label={`${capitalize(t.staffMember)} preferido`}
                options={[{ value: "", label: "Cualquiera" }, ...(options.data?.staff ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                value={draft.staff}
                onChange={(e) => set("staff", e.target.value)}
              />
            </div>

            <fieldset className="field">
              <legend className="field-label">Te toca de nuevo</legend>
              <p className="settings-help">Por ejemplo, a quien se hizo una limpieza hace más de 6 meses.</p>
              <div className="form-grid">
                <SelectField
                  label="Su último servicio"
                  options={[{ value: "", label: "Sin este filtro" }, ...services.map((s) => ({ value: s.id, label: s.name }))]}
                  value={draft.lapsedService}
                  onChange={(e) => set("lapsedService", e.target.value)}
                  error={fieldError("segment.lapsedService.serviceId")}
                />
                <TextField
                  label="Hace al menos (meses)"
                  type="number"
                  min={1}
                  max={60}
                  inputMode="numeric"
                  disabled={!draft.lapsedService}
                  value={draft.lapsedMonths}
                  onChange={(e) => set("lapsedMonths", e.target.value)}
                  error={fieldError("segment.lapsedService.months")}
                />
              </div>
            </fieldset>

            <label className="check-row">
              <input type="checkbox" checked={draft.excludeUpcoming} onChange={(e) => set("excludeUpcoming", e.target.checked)} />
              <span>
                Sin los que ya tienen una {t.appointment} próxima <small className="muted">(ya vuelven solos)</small>
              </span>
            </label>
          </section>

          <FormError message={save.isError && !(isApiError(save.error) && Object.keys(save.error.fields).length > 0) ? errorMessage(save.error) : null} />
          <div className="cp-actions">
            <Link to={initial ? `/campaigns/${initial.id}` : "/campaigns"} className="btn btn-secondary">
              Cancelar
            </Link>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar borrador"}
            </button>
          </div>
        </form>

        <aside className="card cp-preview" aria-labelledby="cp-preview-title" aria-live="polite">
          <h2 id="cp-preview-title" className="card-title">
            Vista previa
          </h2>
          {preview.isError ? (
            <FormError message={errorMessage(preview.error, "No pudimos calcular a quiénes les llega.")} />
          ) : !p ? (
            <p className="muted">Calculando…</p>
          ) : (
            <div className={preview.isFetching ? "refreshing" : undefined}>
              <p className="cp-preview-number tnum" aria-label={`Le llega a ${p.eligible} ${t.clients}`}>
                {p.eligible}
              </p>
              <p>
                {t.clients} la reciben (de {p.matched} que cumplen los filtros)
              </p>
              <ul aria-label="Quedan afuera">
                <li>{p.withoutConsent} sin aceptar promociones</li>
                <li>{p.optedOut} pidieron la baja</li>
                <li>{p.withoutPhone} sin teléfono</li>
              </ul>
              {p.sample.length > 0 && (
                <p className="settings-help">
                  Por ejemplo: {p.sample.map((s) => s.name).join(", ")}
                  {p.eligible > p.sample.length ? "…" : ""}
                </p>
              )}
              <ChannelNotice channels={p.channels} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
