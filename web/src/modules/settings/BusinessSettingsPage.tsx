import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../lib/api";
import { DEFAULT_TERMINOLOGY, type Terminology } from "../../lib/contract";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { CheckRow, fieldErrorOf, LoadingState, mutationError, ReadOnlyNotice } from "./common";
import { COUNTRY_OPTIONS, CURRENCY_OPTIONS, TIMEZONE_OPTIONS, withCurrent } from "./regions";
import { canManageSettings, SETTINGS_KEYS, settingsApi, type BusinessSettings, type BusinessSettingsPatch, type ReminderChannel } from "./settingsApi";

// Configuración > Negocio: nombre, datos legales, región, terminología, recordatorios y marca.

const TERM_FIELDS: { key: keyof Terminology; label: string }[] = [
  { key: "client", label: "Cliente (singular)" },
  { key: "clients", label: "Clientes (plural)" },
  { key: "staffMember", label: "Profesional (singular)" },
  { key: "staff", label: "Profesionales (plural)" },
  { key: "appointment", label: "Cita (singular)" },
  { key: "appointments", label: "Citas (plural)" },
  { key: "location", label: "Sucursal (singular)" },
  { key: "locations", label: "Sucursales (plural)" },
];

const INDUSTRY_LABELS: Record<string, string> = { dental: "Odontología", aesthetics: "Estética", nails: "Uñas", generic: "Otro rubro" };

interface FormState {
  name: string;
  legalName: string;
  taxId: string;
  billingEmail: string;
  timezone: string;
  currency: string;
  country: string;
  terminology: Record<keyof Terminology, string>;
  whatsapp: boolean;
  email: boolean;
  preferred: ReminderChannel;
  accentColor: string;
  headerColor: string;
  logoUrl: string;
}

function toForm(s: BusinessSettings): FormState {
  const terminology = {} as Record<keyof Terminology, string>;
  for (const { key } of TERM_FIELDS) terminology[key] = s.terminology[key] === DEFAULT_TERMINOLOGY[key] ? "" : s.terminology[key];
  return {
    name: s.name,
    legalName: s.legal?.legalName ?? "",
    taxId: s.legal?.taxId ?? "",
    billingEmail: s.legal?.billingEmail ?? "",
    timezone: s.timezone,
    currency: s.currency,
    country: s.country,
    terminology,
    whatsapp: s.reminderChannels.includes("whatsapp"),
    email: s.reminderChannels.includes("email"),
    preferred: s.reminderChannels[0] ?? "whatsapp",
    accentColor: s.branding.accentColor ?? "",
    headerColor: s.branding.headerColor ?? "",
    logoUrl: s.branding.logoUrl ?? "",
  };
}

function toPatch(form: FormState, settings: BusinessSettings): BusinessSettingsPatch {
  const channels: ReminderChannel[] = [];
  if (form.whatsapp) channels.push("whatsapp");
  if (form.email) channels.push("email");
  if (channels.length === 2 && form.preferred === "email") channels.reverse();
  const patch: BusinessSettingsPatch = {
    name: form.name.trim(),
    timezone: form.timezone,
    currency: form.currency,
    country: form.country,
    terminology: { ...form.terminology },
    reminderChannels: channels,
  };
  if (settings.legal) {
    patch.legalName = form.legalName.trim() || null;
    patch.taxId = form.taxId.trim() || null;
    patch.billingEmail = form.billingEmail.trim() || null;
  }
  if (settings.brandingEditable) {
    patch.branding = {
      accentColor: form.accentColor || null,
      headerColor: form.headerColor || null,
      logoUrl: form.logoUrl.trim() || null,
    };
  }
  return patch;
}

export default function BusinessSettingsPage() {
  const me = useSession();
  const canEdit = canManageSettings(me);
  const query = useQuery({ queryKey: SETTINGS_KEYS.business, queryFn: settingsApi.getBusiness });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={errorMessage(query.error, "No pudimos cargar los datos del negocio.")} onRetry={() => void query.refetch()} />;
  // `key`: si los datos cambian (otro dispositivo, guardado), el formulario arranca de lo guardado.
  return <BusinessForm key={query.data.updatedAt} settings={query.data} canEdit={canEdit} />;
}

function BusinessForm({ settings, canEdit }: { settings: BusinessSettings; canEdit: boolean }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [form, setForm] = useState<FormState>(() => toForm(settings));
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: BusinessSettingsPatch) => settingsApi.updateBusiness(patch),
    onSuccess: (saved) => {
      qc.setQueryData(SETTINGS_KEYS.business, saved);
      // Nombre, terminología, moneda y marca se ven en todo el panel (`me`).
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      showToast("Listo, los datos del negocio quedaron guardados.");
    },
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const fieldError = (name: string) => fieldErrorOf(mutation.error, name);
  const disabled = !canEdit || mutation.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setLocalError("Escribí el nombre del negocio.");
      return;
    }
    setLocalError(null);
    mutation.mutate(toPatch(form, settings));
  }

  return (
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      {!canEdit && <ReadOnlyNotice />}

      <section className="card" aria-labelledby="biz-general">
        <h3 id="biz-general" className="card-title">
          Datos generales
        </h3>
        <div className="form-grid">
          <TextField label="Nombre del negocio" value={form.name} disabled={disabled} maxLength={120} error={localError ?? fieldError("name")} onChange={(e) => set("name", e.target.value)} />
          <TextField label="Rubro" value={INDUSTRY_LABELS[settings.industry] ?? settings.industry} readOnly hint="Lo define la plantilla con la que nació el negocio." />
        </div>
        <div className="form-grid">
          <SelectField label="País" value={form.country} disabled={disabled} options={withCurrent(COUNTRY_OPTIONS, form.country)} error={fieldError("country")} onChange={(e) => set("country", e.target.value)} />
          <SelectField
            label="Zona horaria"
            value={form.timezone}
            disabled={disabled}
            options={withCurrent(TIMEZONE_OPTIONS, form.timezone)}
            hint="La de las sucursales nuevas y la del «hoy» de los reportes."
            error={fieldError("timezone")}
            onChange={(e) => set("timezone", e.target.value)}
          />
          <SelectField
            label="Moneda"
            value={form.currency}
            disabled={disabled}
            options={withCurrent(CURRENCY_OPTIONS, form.currency)}
            hint="Cambiarla no convierte los precios ya cargados."
            error={fieldError("currency")}
            onChange={(e) => set("currency", e.target.value)}
          />
        </div>
      </section>

      {settings.legal && (
        <section className="card" aria-labelledby="biz-legal">
          <h3 id="biz-legal" className="card-title">
            Datos legales y de facturación
          </h3>
          <div className="form-grid">
            <TextField label="Razón social" value={form.legalName} disabled={disabled} maxLength={200} error={fieldError("legalName")} onChange={(e) => set("legalName", e.target.value)} />
            <TextField label="Cédula jurídica o identificación" value={form.taxId} disabled={disabled} maxLength={40} error={fieldError("taxId")} onChange={(e) => set("taxId", e.target.value)} />
            <TextField
              label="Correo de facturación"
              type="email"
              autoComplete="email"
              value={form.billingEmail}
              disabled={disabled}
              error={fieldError("billingEmail")}
              onChange={(e) => set("billingEmail", e.target.value)}
            />
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="biz-terms">
        <h3 id="biz-terms" className="card-title">
          Terminología
        </h3>
        <p className="settings-help">Cómo se nombra a cada cosa en el panel y en los mensajes. Vacío = el término por defecto.</p>
        <div className="form-grid">
          {TERM_FIELDS.map(({ key, label }) => (
            <TextField
              key={key}
              label={label}
              value={form.terminology[key]}
              placeholder={DEFAULT_TERMINOLOGY[key]}
              disabled={disabled}
              maxLength={40}
              error={fieldError(`terminology.${key}`)}
              onChange={(e) => set("terminology", { ...form.terminology, [key]: e.target.value })}
            />
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="biz-reminders">
        <h3 id="biz-reminders" className="card-title">
          Recordatorios de citas
        </h3>
        <fieldset className="field">
          <legend>Canales activos</legend>
          <div className="check-list">
            <CheckRow label="WhatsApp" hint="Necesita un número de WhatsApp conectado." checked={form.whatsapp} disabled={disabled} onChange={(v) => set("whatsapp", v)} />
            <CheckRow label="Correo" hint="Solo a quien tenga correo cargado." checked={form.email} disabled={disabled} onChange={(v) => set("email", v)} />
          </div>
        </fieldset>
        {form.whatsapp && form.email && (
          <SelectField
            label="Canal por defecto"
            value={form.preferred}
            disabled={disabled}
            hint="Se usa cuando la persona no eligió uno."
            options={[
              { value: "whatsapp", label: "WhatsApp" },
              { value: "email", label: "Correo" },
            ]}
            onChange={(e) => set("preferred", e.target.value as ReminderChannel)}
          />
        )}
        {!form.whatsapp && !form.email && <p className="settings-help">Sin canales activos el negocio no manda recordatorios.</p>}
      </section>

      <section className="card" aria-labelledby="biz-brand">
        <h3 id="biz-brand" className="card-title">
          Marca
        </h3>
        {!settings.brandingEditable && <p className="settings-help">La marca propia es parte del plan Pro.</p>}
        <div className="form-grid">
          <ColorField label="Color principal" value={form.accentColor} disabled={disabled || !settings.brandingEditable} error={fieldError("branding.accentColor")} onChange={(v) => set("accentColor", v)} />
          <ColorField label="Color del menú" value={form.headerColor} disabled={disabled || !settings.brandingEditable} error={fieldError("branding.headerColor")} onChange={(v) => set("headerColor", v)} />
        </div>
        <TextField
          label="Logo (URL https)"
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={form.logoUrl}
          disabled={disabled || !settings.brandingEditable}
          error={fieldError("branding.logoUrl")}
          onChange={(e) => set("logoUrl", e.target.value)}
        />
      </section>

      {canEdit && (
        <>
          <FormError message={mutationError(mutation.error)} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" disabled={mutation.isPending} onClick={() => setForm(toForm(settings))}>
              Descartar cambios
            </button>
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function ColorField({ label, value, disabled, error, onChange }: { label: string; value: string; disabled: boolean; error?: string; onChange: (v: string) => void }) {
  return (
    <div className="color-input">
      <div className="color-input-text">
        <TextField label={label} value={value} placeholder="#rrggbb (vacío = el de la plataforma)" disabled={disabled} maxLength={7} error={error} onChange={(e) => onChange(e.target.value.trim())} />
      </div>
      <input type="color" aria-label={`${label}: elegir en la paleta`} value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#0b7d72"} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
