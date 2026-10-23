import { lazy, Suspense, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorMessage, isApiError, IS_MOCK_API } from "../../lib/api";
import { PRODUCT_NAME } from "../../lib/branding";
import type { SignupInput } from "../../lib/contract";
import { FormError, PasswordField, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import AuthLayout from "../auth/AuthLayout";
import { MIN_PASSWORD_LENGTH } from "../auth/authApi";
import { COUNTRY_OPTIONS, CURRENCY_OPTIONS, TIMEZONE_OPTIONS } from "../settings/regions";
import { resendVerification, signup, useSignupOptions } from "./onboardingApi";
import "./onboarding.css";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (/signup, pública): nombre del negocio, rubro (plantillas), país con
// su zona y moneda, y los datos de la dueña. El backend responde SIEMPRE "revisá tu
// correo" (exista o no la cuenta), así que la pantalla de éxito habla en condicional.
// `website` es un honeypot: oculto para las personas, un bot lo completa.
// ─────────────────────────────────────────────────────────────────────────────

// La ayuda con el enlace de verificación solo existe en modo mock.
const MockVerificationHint = IS_MOCK_API ? lazy(() => import("./MockVerificationHint")) : null;

/** Rubros por si /signup/options no responde (los mismos de las plantillas). */
const FALLBACK_INDUSTRIES = [
  { id: "dental", label: "Odontología" },
  { id: "aesthetics", label: "Estética" },
  { id: "nails", label: "Uñas" },
  { id: "generic", label: "Otro rubro" },
];

/** Zona y moneda que propone cada país (se pueden cambiar). */
const COUNTRY_PRESETS: Record<string, { timezone: string; currency: string }> = {
  CR: { timezone: "America/Costa_Rica", currency: "CRC" },
  PA: { timezone: "America/Panama", currency: "USD" },
  NI: { timezone: "America/Managua", currency: "NIO" },
  HN: { timezone: "America/Tegucigalpa", currency: "HNL" },
  SV: { timezone: "America/El_Salvador", currency: "USD" },
  GT: { timezone: "America/Guatemala", currency: "GTQ" },
  MX: { timezone: "America/Mexico_City", currency: "MXN" },
  CO: { timezone: "America/Bogota", currency: "COP" },
};

const EMPTY: SignupInput = {
  businessName: "",
  industry: "dental",
  country: "CR",
  timezone: "America/Costa_Rica",
  currency: "CRC",
  ownerName: "",
  email: "",
  password: "",
  website: "",
};

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Field = keyof SignupInput;

function validate(input: SignupInput): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!input.businessName.trim()) errors.businessName = "Escribí el nombre de tu negocio.";
  if (!input.ownerName.trim()) errors.ownerName = "Escribí tu nombre.";
  if (!input.email.trim()) errors.email = "Escribí tu correo.";
  else if (!RE_EMAIL.test(input.email.trim())) errors.email = "Escribí un correo válido.";
  if (input.password.length < MIN_PASSWORD_LENGTH) errors.password = `Usá al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  return errors;
}

/** "Revisá tu correo", con reenvío del enlace. */
export function CheckEmail({ email, trialDays }: { email: string; trialDays: number | null }) {
  const resend = useMutation({ mutationFn: () => resendVerification(email) });
  return (
    <AuthLayout title="Revisá tu correo">
      <div className="auth-done" role="status">
        <div className="empty-state-icon">
          <Icon id="mail" size={24} strokeWidth={1.6} />
        </div>
        <p>
          Te mandamos un enlace a <strong>{email}</strong> para confirmar tu cuenta{trialDays ? ` y empezar tus ${trialDays} días de prueba` : ""}.
          Vence en 2 días; revisá también la carpeta de correo no deseado.
        </p>
        <p className="muted">Si ese correo ya tenía una cuenta, te contamos ahí cómo entrar.</p>
      </div>
      {MockVerificationHint && (
        <Suspense fallback={null}>
          <MockVerificationHint />
        </Suspense>
      )}
      <button type="button" className="btn btn-secondary btn-block" onClick={() => resend.mutate()} disabled={resend.isPending}>
        {resend.isPending ? "Reenviando…" : resend.isSuccess ? "Listo, te lo reenviamos" : "Reenviar el correo"}
      </button>
      <FormError message={resend.isError ? errorMessage(resend.error) : null} />
      <Link to="/login" className="link auth-secondary">
        Ya confirmé: ingresar
      </Link>
    </AuthLayout>
  );
}

export default function SignupPage() {
  const options = useSignupOptions();
  const [form, setForm] = useState<SignupInput>(EMPTY);
  const [localErrors, setLocalErrors] = useState<Partial<Record<Field, string>>>({});
  const mutation = useMutation({ mutationFn: (input: SignupInput) => signup(input) });
  const industries = options.data?.industries ?? FALLBACK_INDUSTRIES;
  const trialDays = options.data?.trialDays ?? null;

  function set<K extends Field>(key: K, value: SignupInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setLocalErrors((e) => ({ ...e, [key]: undefined }));
  }

  function onCountryChange(country: string) {
    setForm((f) => ({ ...f, country, ...(COUNTRY_PRESETS[country] ?? {}) }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const errors = validate(form);
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate({ ...form, businessName: form.businessName.trim(), ownerName: form.ownerName.trim(), email: form.email.trim() });
  }

  if (mutation.isSuccess) return <CheckEmail email={form.email.trim()} trialDays={trialDays} />;

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const errorFor = (key: Field) => localErrors[key] ?? apiError?.fieldError(key);
  const hasFieldErrors = apiError ? Object.keys(apiError.fields).length > 0 : false;
  const formError = mutation.isError ? (hasFieldErrors ? apiError?.message : errorMessage(mutation.error)) : null;

  return (
    <AuthLayout
      title={`Probá ${PRODUCT_NAME} gratis`}
      intro={trialDays ? `${trialDays} días gratis, sin tarjeta. Tu agenda, tus clientes y tu WhatsApp en un solo lugar.` : "Tu agenda, tus clientes y tu WhatsApp en un solo lugar."}
    >
      <form onSubmit={onSubmit} noValidate className="signup-form">
        <TextField
          label="Nombre del negocio"
          name="businessName"
          autoComplete="organization"
          required
          value={form.businessName}
          error={errorFor("businessName")}
          onChange={(e) => set("businessName", e.target.value)}
        />
        <SelectField
          label="Rubro"
          name="industry"
          value={form.industry}
          options={industries.map((i) => ({ value: i.id, label: i.label }))}
          hint="Precargamos servicios de ejemplo, campos y textos de tu rubro: después los ajustás."
          error={errorFor("industry")}
          onChange={(e) => set("industry", e.target.value)}
        />
        <div className="signup-row">
          <SelectField label="País" name="country" value={form.country} options={COUNTRY_OPTIONS} error={errorFor("country")} onChange={(e) => onCountryChange(e.target.value)} />
          <SelectField label="Moneda" name="currency" value={form.currency} options={CURRENCY_OPTIONS} error={errorFor("currency")} onChange={(e) => set("currency", e.target.value)} />
        </div>
        <SelectField label="Zona horaria" name="timezone" value={form.timezone} options={TIMEZONE_OPTIONS} error={errorFor("timezone")} onChange={(e) => set("timezone", e.target.value)} />
        <TextField label="Tu nombre" name="ownerName" autoComplete="name" required value={form.ownerName} error={errorFor("ownerName")} onChange={(e) => set("ownerName", e.target.value)} />
        <TextField
          label="Tu correo"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={form.email}
          hint="Te mandamos un enlace para confirmarlo."
          error={errorFor("email")}
          onChange={(e) => set("email", e.target.value)}
        />
        <PasswordField
          label="Clave"
          name="password"
          autoComplete="new-password"
          required
          value={form.password}
          hint={`Al menos ${MIN_PASSWORD_LENGTH} caracteres.`}
          error={errorFor("password")}
          onChange={(e) => set("password", e.target.value)}
        />
        {/* Honeypot: fuera de la vista y del orden de tabulación; una persona no lo completa. */}
        <div className="signup-hp" aria-hidden="true">
          <label htmlFor="signup-website">Sitio web</label>
          <input id="signup-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set("website", e.target.value)} />
        </div>
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Creando tu cuenta…" : "Crear mi cuenta"}
        </button>
        <p className="signup-legal">
          Al crear tu cuenta aceptás los <a href="/terminos">Términos</a> y la <a href="/privacidad">Política de privacidad</a>.
        </p>
        <Link to="/login" className="link auth-secondary">
          ¿Ya tenés cuenta? Ingresá
        </Link>
      </form>
    </AuthLayout>
  );
}
