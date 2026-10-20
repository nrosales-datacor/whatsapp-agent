import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, isApiError } from "../../lib/api";
import type { CreateBusinessInput } from "../../lib/contract";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { ADMIN_BUSINESSES_QUERY_KEY, createBusiness } from "./adminApi";

// Rubros: las plantillas de src/modules/business/templates (PLAN-GESTION.md §3).
export const INDUSTRY_OPTIONS = [
  { value: "dental", label: "Odontología" },
  { value: "aesthetics", label: "Estética" },
  { value: "nails", label: "Uñas" },
  { value: "generic", label: "Otro rubro" },
] as const;

const COUNTRY_OPTIONS = [
  { value: "CR", label: "Costa Rica", timezone: "America/Costa_Rica", currency: "CRC" },
  { value: "PA", label: "Panamá", timezone: "America/Panama", currency: "USD" },
  { value: "NI", label: "Nicaragua", timezone: "America/Managua", currency: "NIO" },
  { value: "HN", label: "Honduras", timezone: "America/Tegucigalpa", currency: "HNL" },
  { value: "SV", label: "El Salvador", timezone: "America/El_Salvador", currency: "USD" },
  { value: "GT", label: "Guatemala", timezone: "America/Guatemala", currency: "GTQ" },
  { value: "MX", label: "México", timezone: "America/Mexico_City", currency: "MXN" },
  { value: "CO", label: "Colombia", timezone: "America/Bogota", currency: "COP" },
] as const;

const TIMEZONE_OPTIONS = [...new Set(COUNTRY_OPTIONS.map((c) => c.timezone))].map((tz) => ({ value: tz, label: tz }));
const CURRENCY_OPTIONS = [...new Set([...COUNTRY_OPTIONS.map((c) => c.currency), "USD"])].map((c) => ({ value: c, label: c }));

const EMPTY: CreateBusinessInput = {
  name: "",
  industry: "dental",
  country: "CR",
  timezone: "America/Costa_Rica",
  currency: "CRC",
  locationName: "",
  ownerName: "",
  ownerEmail: "",
};

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Field = keyof CreateBusinessInput;

function validate(input: CreateBusinessInput): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!input.name.trim()) errors.name = "Escribí el nombre del negocio.";
  if (!input.locationName.trim()) errors.locationName = "Escribí el nombre de la primera sucursal.";
  if (!input.ownerName.trim()) errors.ownerName = "Escribí el nombre del dueño.";
  if (!input.ownerEmail.trim()) errors.ownerEmail = "Escribí el correo del dueño.";
  else if (!RE_EMAIL.test(input.ownerEmail.trim())) errors.ownerEmail = "Escribí un correo válido.";
  return errors;
}

/** Alta de un negocio (`POST /admin/businesses`) con los campos del contrato. */
export default function CreateBusinessForm() {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [form, setForm] = useState<CreateBusinessInput>(EMPTY);
  const [localErrors, setLocalErrors] = useState<Partial<Record<Field, string>>>({});

  const mutation = useMutation({
    mutationFn: (input: CreateBusinessInput) => createBusiness(input),
    onSuccess: (_created, input) => {
      showToast(`Negocio «${input.name}» creado.`);
      setForm(EMPTY);
      setLocalErrors({});
      void qc.invalidateQueries({ queryKey: ADMIN_BUSINESSES_QUERY_KEY });
    },
  });

  function set<K extends Field>(key: K, value: CreateBusinessInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setLocalErrors((e) => ({ ...e, [key]: undefined }));
  }

  function onCountryChange(country: string) {
    const preset = COUNTRY_OPTIONS.find((c) => c.value === country);
    setForm((f) => ({ ...f, country, ...(preset ? { timezone: preset.timezone, currency: preset.currency } : {}) }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const errors = validate(form);
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const trimmed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()])) as unknown as CreateBusinessInput;
    mutation.mutate(trimmed);
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const errorFor = (key: Field) => localErrors[key] ?? apiError?.fieldError(key);
  const hasFieldErrors = apiError ? Object.keys(apiError.fields).length > 0 : false;
  const formError = mutation.isError ? (hasFieldErrors ? apiError?.message : errorMessage(mutation.error)) : null;

  return (
    <form className="card" onSubmit={onSubmit} noValidate aria-labelledby="create-business-title">
      <h2 id="create-business-title" className="card-title">
        Dar de alta un negocio
      </h2>
      <div className="form-grid">
        <TextField label="Nombre del negocio" name="name" required value={form.name} error={errorFor("name")} onChange={(e) => set("name", e.target.value)} />
        <SelectField label="Rubro" name="industry" value={form.industry} options={INDUSTRY_OPTIONS} error={errorFor("industry")} onChange={(e) => set("industry", e.target.value)} />
        <SelectField label="País" name="country" value={form.country} options={COUNTRY_OPTIONS} error={errorFor("country")} onChange={(e) => onCountryChange(e.target.value)} />
        <SelectField label="Zona horaria" name="timezone" value={form.timezone} options={TIMEZONE_OPTIONS} error={errorFor("timezone")} onChange={(e) => set("timezone", e.target.value)} />
        <SelectField label="Moneda" name="currency" value={form.currency} options={CURRENCY_OPTIONS} error={errorFor("currency")} onChange={(e) => set("currency", e.target.value)} />
        <TextField
          label="Primera sucursal"
          name="locationName"
          required
          placeholder="Ej.: Escazú"
          value={form.locationName}
          error={errorFor("locationName")}
          onChange={(e) => set("locationName", e.target.value)}
        />
        <TextField label="Nombre del dueño" name="ownerName" autoComplete="off" required value={form.ownerName} error={errorFor("ownerName")} onChange={(e) => set("ownerName", e.target.value)} />
        <TextField
          label="Correo del dueño"
          name="ownerEmail"
          type="email"
          autoComplete="off"
          required
          value={form.ownerEmail}
          error={errorFor("ownerEmail")}
          onChange={(e) => set("ownerEmail", e.target.value)}
        />
      </div>
      <FormError message={formError} />
      <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? "Creando…" : "Crear negocio"}
      </button>
    </form>
  );
}
