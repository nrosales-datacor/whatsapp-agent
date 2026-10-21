import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import type { Terminology } from "../../lib/contract";
import { formatAmount } from "../../lib/money";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import ClientAppointments from "../scheduling/ClientAppointments";
import AnonymizeClient from "./AnonymizeClient";
import { canEditClients, type ClientListState } from "./ClientsPage";
import {
  useClient,
  useClientFormOptions,
  useUpdateClient,
  type ClientChannel,
  type ClientDetail,
  type ClientFormOptions,
  type ClientPatch,
  type ClientRef,
} from "./clientsApi";
import { displayName, formatDateOnly, formatDay, formatPhone } from "./format";
import GuardianPicker from "./GuardianPicker";
import "./clients.css";

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 40;

function BackLink({ t }: { t: Terminology }) {
  // Si se llegó desde la lista, se vuelve a la misma búsqueda y orden.
  const listSearch = (useLocation().state as ClientListState | null)?.listSearch;
  return (
    <Link to={listSearch ? `/clients?${listSearch}` : "/clients"} className="back-link">
      <Icon id="chevronLeft" size={16} />
      Volver a {capitalize(t.clients)}
    </Link>
  );
}

/** Ficha de un cliente (/clients/:id), enlazable desde una notificación o una cita. */
export default function ClientDetailPage() {
  const { id = "" } = useParams();
  const me = useSession();
  const t = terminologyOf(me);
  const query = useClient(me.business.id, id);

  if (query.isPending) {
    return (
      <div className="page">
        <BackLink t={t} />
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando la ficha…</span>
        </div>
      </div>
    );
  }

  if (query.isError) {
    const missing = isApiError(query.error) && (query.error.status === 404 || query.error.status === 400);
    return (
      <div className="page">
        <PageHeader title={`Ficha del ${t.client}`} />
        <BackLink t={t} />
        {missing ? (
          <EmptyState icon="user" title={`No encontramos este ${t.client}`} help="Puede que el enlace esté incompleto o que sea de otro negocio." />
        ) : (
          <ErrorState message="No pudimos cargar la ficha." onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const client = query.data;
  const name = displayName(client, t);
  return (
    <div className="page">
      <BackLink t={t} />
      <PageHeader title={name} tabTitle={`${name} · ${capitalize(t.clients)}`} subtitle={client.anonymized ? "Datos eliminados" : formatPhone(client.phone) || "Sin teléfono"} />

      {client.anonymized ? (
        <EmptyState
          icon="shield"
          title={`Los datos de este ${t.client} se eliminaron`}
          help={`Se borraron a pedido del ${t.client} (derecho de supresión). Sus ${t.appointments} y pagos quedan en el historial, sin sus datos personales.`}
        />
      ) : (
        // `key`: al guardar (o si otro lo editó) el formulario arranca de lo que dice el servidor.
        <ClientForm key={`${client.id}:${client.updatedAt}`} client={client} />
      )}

      <ClientAppointments client={client} />

      {me.role === "owner" && !client.anonymized && <AnonymizeClient client={client} />}
    </div>
  );
}

// ── Formulario de la ficha ──────────────────────────────────────────────────

interface FormState {
  name: string;
  phone: string;
  email: string;
  birthDate: string;
  notes: string;
  tags: string[];
  preferredLocationId: string;
  preferredStaffId: string;
  preferredChannel: string;
  guardian: ClientRef | null;
}

type FieldKey = "name" | "phone" | "email" | "birthDate" | "notes" | "tags" | "preferredLocationId" | "preferredStaffId" | "preferredChannel" | "guardianId";

function initialState(c: ClientDetail): FormState {
  return {
    name: c.name,
    phone: formatPhone(c.phone),
    email: c.email ?? "",
    birthDate: c.birthDate ?? "",
    notes: c.notes ?? "",
    tags: c.tags,
    preferredLocationId: c.preferredLocationId ?? "",
    preferredStaffId: c.preferredStaffId ?? "",
    preferredChannel: c.preferredChannel ?? "",
    guardian: c.guardian,
  };
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
const digits = (v: string) => v.replace(/\D/g, "");

/** Solo lo que cambió respecto de lo guardado (PATCH parcial). */
function diff(c: ClientDetail, f: FormState): ClientPatch {
  const patch: ClientPatch = {};
  if (f.name.trim() !== c.name) patch.name = f.name.trim();
  // El teléfono se muestra con espacios: cambia solo si cambian los dígitos.
  if (digits(f.phone) !== digits(c.phone ?? "")) patch.phone = orNull(f.phone);
  if ((orNull(f.email)?.toLowerCase() ?? null) !== c.email) patch.email = orNull(f.email);
  if (orNull(f.birthDate) !== c.birthDate) patch.birthDate = orNull(f.birthDate);
  if (orNull(f.notes) !== (c.notes ?? null)) patch.notes = orNull(f.notes);
  if (JSON.stringify(f.tags) !== JSON.stringify(c.tags)) patch.tags = f.tags;
  if (orNull(f.preferredLocationId) !== c.preferredLocationId) patch.preferredLocationId = orNull(f.preferredLocationId);
  if (orNull(f.preferredStaffId) !== c.preferredStaffId) patch.preferredStaffId = orNull(f.preferredStaffId);
  if (orNull(f.preferredChannel) !== c.preferredChannel) patch.preferredChannel = orNull(f.preferredChannel) as ClientChannel | null;
  if ((f.guardian?.id ?? null) !== c.guardianId) patch.guardianId = f.guardian?.id ?? null;
  return patch;
}

/** Opciones de un select: "Sin preferencia", las activas y la actual aunque esté inactiva o no se conozca. */
function selectOptions(items: ClientFormOptions["locations"] | undefined, current: string | null, emptyLabel: string) {
  const list = (items ?? []).filter((i) => i.active || i.id === current).map((i) => ({ value: i.id, label: i.active ? i.name : `${i.name} (inactivo)` }));
  if (current && !list.some((o) => o.value === current)) list.push({ value: current, label: "Otra (no disponible)" });
  return [{ value: "", label: emptyLabel }, ...list];
}

function ClientForm({ client }: { client: ClientDetail }) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const canEdit = canEditClients(me.role);
  const options = useClientFormOptions(me.business.id);
  const mutation = useUpdateClient(me.business.id, client.id);
  const [form, setForm] = useState<FormState>(() => initialState(client));
  const [localErrors, setLocalErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [tagDraft, setTagDraft] = useState("");
  const [pickingGuardian, setPickingGuardian] = useState(false);
  const notesId = useId();
  const tagInputId = useId();

  const patch = useMemo(() => diff(client, form), [client, form]);
  const dirty = Object.keys(patch).length > 0;
  const tz = me.business.timezone;
  const showSpend = me.modules.includes("sales");

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    const errorKey = (key === "guardian" ? "guardianId" : key) as FieldKey;
    setLocalErrors((e) => ({ ...e, [errorKey]: undefined }));
    if (mutation.isError) mutation.reset();
  }

  function addTag() {
    const tag = tagDraft.trim();
    if (!tag) return;
    if (tag.length > MAX_TAG_LENGTH) {
      setLocalErrors((e) => ({ ...e, tags: `Una etiqueta puede tener hasta ${MAX_TAG_LENGTH} caracteres.` }));
      return;
    }
    if (form.tags.some((x) => x.toLocaleLowerCase("es") === tag.toLocaleLowerCase("es"))) {
      setTagDraft("");
      return;
    }
    if (form.tags.length >= MAX_TAGS) {
      setLocalErrors((e) => ({ ...e, tags: `Hasta ${MAX_TAGS} etiquetas.` }));
      return;
    }
    set("tags", [...form.tags, tag]);
    setTagDraft("");
  }

  function onTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || mutation.isPending) return;
    const errors: Partial<Record<FieldKey, string>> = {};
    if (!form.name.trim()) errors.name = "Escribí el nombre.";
    if (form.email.trim() && !RE_EMAIL.test(form.email.trim())) errors.email = "Escribí un correo válido.";
    if (form.preferredChannel === "email" && !form.email.trim()) errors.preferredChannel = "Para avisarle por correo, primero cargá su correo.";
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(patch, { onSuccess: () => showToast("Cambios guardados.") });
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const phoneTaken = apiError?.code === "phone_taken" ? apiError.message : undefined;
  const errorFor = (key: FieldKey) => localErrors[key] ?? apiError?.fieldError(key) ?? (key === "phone" ? phoneTaken : undefined);
  const hasFieldErrors = apiError ? Object.keys(apiError.fields).some((k) => k.startsWith("body.")) || Boolean(phoneTaken) : false;
  const formError = mutation.isError ? (hasFieldErrors ? "Revisá los campos marcados." : errorMessage(mutation.error)) : null;

  const locationOptions = selectOptions(options.data?.locations, client.preferredLocationId, "Sin preferencia");
  const staffOptions = selectOptions(options.data?.staff, client.preferredStaffId, "Sin preferencia");
  const channelOptions = [
    { value: "", label: "El que use el negocio" },
    { value: "whatsapp", label: "WhatsApp" },
    { value: "email", label: "Correo" },
  ];

  return (
    <>
      <form onSubmit={onSubmit} noValidate aria-label={`Ficha de ${client.name}`}>
        <fieldset disabled={!canEdit} className="client-fieldset">
          {!canEdit && (
            <legend className="client-readonly-note">
              <Icon id="lock" size={14} /> Solo lectura: tu rol puede ver la ficha, no editarla.
            </legend>
          )}
          <div className="client-detail-grid">
            <div className="client-col">
              <section className="card client-section" aria-labelledby="client-data-title">
                <h2 id="client-data-title" className="card-title">
                  Datos
                </h2>
                <div className="form-grid">
                  <TextField label="Nombre" name="name" autoComplete="off" required value={form.name} error={errorFor("name")} onChange={(e) => set("name", e.target.value)} />
                  <TextField
                    label="Teléfono"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="8888 7777"
                    value={form.phone}
                    error={errorFor("phone")}
                    onChange={(e) => set("phone", e.target.value)}
                  />
                  <TextField
                    label="Correo"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    value={form.email}
                    error={errorFor("email")}
                    onChange={(e) => set("email", e.target.value)}
                  />
                  <TextField
                    label="Fecha de nacimiento"
                    name="birthDate"
                    type="date"
                    max={new Date().toISOString().slice(0, 10)}
                    value={form.birthDate}
                    error={errorFor("birthDate")}
                    onChange={(e) => set("birthDate", e.target.value)}
                  />
                </div>

                <div className="field">
                  <div className="field-label-row">
                    <span className="field-label" id="client-guardian-label">
                      Responsable
                    </span>
                  </div>
                  <div className="client-guardian" aria-labelledby="client-guardian-label">
                    {form.guardian ? (
                      <Link to={`/clients/${form.guardian.id}`} className="link">
                        {form.guardian.name}
                      </Link>
                    ) : (
                      <span className="muted">Sin responsable</span>
                    )}
                    {canEdit && (
                      <span className="client-guardian-actions">
                        <button type="button" className="link-button" onClick={() => setPickingGuardian(true)}>
                          {form.guardian ? "Cambiar" : "Elegir"}
                        </button>
                        {form.guardian && (
                          <button type="button" className="link-button" onClick={() => set("guardian", null)}>
                            Quitar
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {errorFor("guardianId") ? (
                    <p className="field-error">{errorFor("guardianId")}</p>
                  ) : (
                    <p className="field-hint">Para un menor: la persona a cargo, que también es {t.client} del negocio.</p>
                  )}
                  {client.dependents.length > 0 && (
                    <p className="field-hint">
                      Responsable de:{" "}
                      {client.dependents.map((d, i) => (
                        <span key={d.id}>
                          {i > 0 && ", "}
                          <Link to={`/clients/${d.id}`} className="link">
                            {d.name}
                          </Link>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </section>

              <section className="card client-section" aria-labelledby="client-prefs-title">
                <h2 id="client-prefs-title" className="card-title">
                  Preferencias
                </h2>
                <div className="form-grid">
                  <SelectField
                    label={`${capitalize(t.location)} preferida`}
                    value={form.preferredLocationId}
                    options={locationOptions}
                    error={errorFor("preferredLocationId")}
                    onChange={(e) => set("preferredLocationId", e.target.value)}
                  />
                  <SelectField
                    label={`${capitalize(t.staffMember)} preferido`}
                    value={form.preferredStaffId}
                    options={staffOptions}
                    error={errorFor("preferredStaffId")}
                    hint={options.isError ? "No pudimos cargar las opciones." : undefined}
                    onChange={(e) => set("preferredStaffId", e.target.value)}
                  />
                  <SelectField
                    label="Recordatorios por"
                    value={form.preferredChannel}
                    options={channelOptions}
                    error={errorFor("preferredChannel")}
                    onChange={(e) => set("preferredChannel", e.target.value)}
                  />
                </div>
              </section>
            </div>

            <div className="client-col">
              <section className="card client-section" aria-labelledby="client-summary-title">
                <h2 id="client-summary-title" className="card-title">
                  Resumen
                </h2>
                <dl className="client-summary">
                  <div>
                    <dt>Visitas</dt>
                    <dd className="tnum">{client.visitCount}</dd>
                  </div>
                  <div>
                    <dt>Última visita</dt>
                    <dd className="tnum">{client.lastVisitAt ? formatDay(client.lastVisitAt, tz) : "Nunca"}</dd>
                  </div>
                  {showSpend && (
                    <div>
                      <dt>Gasto total</dt>
                      <dd className="tnum">{formatAmount(client.totalSpentCents / 100, me.business.currency)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{capitalize(t.client)} desde</dt>
                    <dd className="tnum">{formatDay(client.createdAt, tz)}</dd>
                  </div>
                  {client.birthDate && (
                    <div>
                      <dt>Nacimiento</dt>
                      <dd className="tnum">{formatDateOnly(client.birthDate)}</dd>
                    </div>
                  )}
                  {client.source && (
                    <div>
                      <dt>Llegó por</dt>
                      <dd>{client.source}</dd>
                    </div>
                  )}
                </dl>
              </section>

              <section className="card client-section" aria-labelledby="client-notes-title">
                <h2 id="client-notes-title" className="card-title">
                  <label htmlFor={notesId}>Notas</label>
                </h2>
                <textarea
                  id={notesId}
                  className="input client-notes"
                  rows={5}
                  maxLength={5000}
                  placeholder={`Lo que conviene recordar de este ${t.client}.`}
                  value={form.notes}
                  aria-invalid={errorFor("notes") ? true : undefined}
                  onChange={(e) => set("notes", e.target.value)}
                />
                {errorFor("notes") && <p className="field-error">{errorFor("notes")}</p>}
              </section>

              <section className="card client-section" aria-labelledby="client-tags-title">
                <h2 id="client-tags-title" className="card-title">
                  Etiquetas
                </h2>
                {form.tags.length > 0 ? (
                  <ul className="client-tags">
                    {form.tags.map((tag) => (
                      <li key={tag} className="client-tag">
                        <span>{tag}</span>
                        {canEdit && (
                          <button
                            type="button"
                            className="client-tag-remove"
                            aria-label={`Quitar la etiqueta ${tag}`}
                            onClick={() => set("tags", form.tags.filter((x) => x !== tag))}
                          >
                            <Icon id="x" size={12} strokeWidth={2.4} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Sin etiquetas.</p>
                )}
                {canEdit && (
                  <div className="client-tag-add">
                    <label htmlFor={tagInputId} className="visually-hidden">
                      Nueva etiqueta
                    </label>
                    <input
                      id={tagInputId}
                      className="input"
                      placeholder="Nueva etiqueta"
                      maxLength={MAX_TAG_LENGTH + 10}
                      value={tagDraft}
                      aria-invalid={errorFor("tags") ? true : undefined}
                      onChange={(e) => {
                        setTagDraft(e.target.value);
                        setLocalErrors((x) => ({ ...x, tags: undefined }));
                      }}
                      onKeyDown={onTagKeyDown}
                    />
                    <button type="button" className="btn btn-secondary" onClick={addTag} disabled={!tagDraft.trim()}>
                      Agregar
                    </button>
                  </div>
                )}
                {errorFor("tags") && <p className="field-error">{errorFor("tags")}</p>}
              </section>
            </div>
          </div>
        </fieldset>

        {canEdit && (dirty || mutation.isError) && (
          <div className="client-savebar" role="region" aria-label="Cambios sin guardar">
            <div className="client-savebar-text">
              <FormError message={formError} />
              {!formError && <span>Tenés cambios sin guardar.</span>}
            </div>
            <div className="client-savebar-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setForm(initialState(client));
                  setLocalErrors({});
                  mutation.reset();
                }}
              >
                Descartar
              </button>
              <button type="submit" className="btn btn-primary" disabled={!dirty || mutation.isPending}>
                {mutation.isPending ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </div>
        )}

      </form>

      {/* Fuera del <form>: Enter en su buscador no debe enviar la ficha. */}
      {canEdit && (
        <GuardianPicker open={pickingGuardian} onClose={() => setPickingGuardian(false)} clientId={client.id} onPick={(g) => set("guardian", g)} />
      )}
    </>
  );
}
