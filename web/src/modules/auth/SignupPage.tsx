import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { errorMessage, isApiError } from "../../lib/api";
import type { Plan, SignupInput } from "../../lib/contract";
import { FormError, PasswordField, SelectField, TextField } from "../../ui/Field";
import FullPageStatus from "../../ui/FullPageStatus";
import Icon from "../../ui/Icons";
import { INDUSTRY_OPTIONS } from "../admin/CreateBusinessForm";
import { COUNTRY_DEFAULTS, COUNTRY_OPTIONS } from "../settings/regions";
import AuthLayout from "./AuthLayout";
import { getSignupConfig, MIN_PASSWORD_LENGTH, resendVerification, signUp, SIGNUP_CONFIG_QUERY_KEY } from "./authApi";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (I6.7, `POST /auth/signup`): el negocio, su rubro (la plantilla que
// precarga servicios y terminología), el país (de ahí salen zona horaria y moneda), el plan
// y la cuenta de quien lo registra. Solo existe con el alta abierta en el backend
// (`GET /auth/signup/config`); si no, vuelve al login.
//
// La respuesta es la misma exista o no el correo (el backend no revela qué cuentas hay):
// "Revisá tu correo" con la opción de reenviar el enlace.
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_OPTIONS = [
  { value: "pro", label: "Pro · la gestión completa (clientes, cobros, comisiones, reportes)" },
  { value: "basic", label: "Básico · el agente de WhatsApp con la agenda" },
] as const;

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Form {
  businessName: string;
  industry: string;
  country: string;
  plan: Plan;
  ownerName: string;
  email: string;
  password: string;
  acceptTerms: boolean;
}

const EMPTY: Form = {
  businessName: "",
  industry: "dental",
  country: "CR",
  plan: "pro",
  ownerName: "",
  email: "",
  password: "",
  acceptTerms: false,
};

type Field = keyof Form;

function validate(form: Form): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!form.businessName.trim()) errors.businessName = "Escribí el nombre de tu negocio.";
  if (!form.ownerName.trim()) errors.ownerName = "Escribí tu nombre.";
  if (!form.email.trim()) errors.email = "Escribí tu correo.";
  else if (!RE_EMAIL.test(form.email.trim())) errors.email = "Escribí un correo válido.";
  if (form.password.length < MIN_PASSWORD_LENGTH) errors.password = `La clave tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (!form.acceptTerms) errors.acceptTerms = "Tenés que aceptar los términos y el aviso de privacidad.";
  return errors;
}

function toInput(form: Form): SignupInput {
  const defaults = COUNTRY_DEFAULTS[form.country] ?? COUNTRY_DEFAULTS.CR;
  return {
    businessName: form.businessName.trim(),
    industry: form.industry,
    country: form.country,
    timezone: defaults.timezone,
    currency: defaults.currency,
    plan: form.plan,
    ownerName: form.ownerName.trim(),
    email: form.email.trim(),
    password: form.password,
    acceptTerms: form.acceptTerms,
  };
}

/** "Revisá tu correo": después del alta, con reenviar el enlace. */
function CheckEmail({ email }: { email: string }) {
  const resend = useMutation({ mutationFn: () => resendVerification(email) });
  return (
    <AuthLayout title="Revisá tu correo">
      <div className="auth-done" role="status">
        <div className="empty-state-icon">
          <Icon id="mail" size={24} strokeWidth={1.6} />
        </div>
        <p>
          Te mandamos un enlace a <strong>{email}</strong> para confirmar tu correo. Abrilo y después entrá con tu clave. Revisá
          también la carpeta de correo no deseado.
        </p>
        {resend.isSuccess && <p>Listo: si la cuenta está esperando la confirmación, te llega un enlace nuevo.</p>}
      </div>
      <FormError message={resend.isError ? errorMessage(resend.error) : null} />
      <button type="button" className="btn btn-secondary btn-block" disabled={resend.isPending} onClick={() => resend.mutate()}>
        {resend.isPending ? "Enviando…" : "Reenviar el enlace"}
      </button>
      <Link to="/login" className="link auth-secondary">
        Ir a ingresar
      </Link>
    </AuthLayout>
  );
}

export default function SignupPage() {
  const config = useQuery({ queryKey: SIGNUP_CONFIG_QUERY_KEY, queryFn: getSignupConfig, staleTime: 60_000 });
  const [form, setForm] = useState<Form>(EMPTY);
  const [localErrors, setLocalErrors] = useState<Partial<Record<Field, string>>>({});
  const mutation = useMutation({ mutationFn: (input: SignupInput) => signUp(input) });

  if (config.isPending) return <FullPageStatus message="Cargando…" />;
  if (!config.data?.enabled) return <Navigate to="/login" replace />;
  if (mutation.isSuccess) return <CheckEmail email={form.email.trim()} />;

  const set = <K extends Field>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setLocalErrors((e) => ({ ...e, [key]: undefined }));
  };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const errors = validate(form);
    setLocalErrors(errors);
    if (Object.keys(errors).length === 0) mutation.mutate(toInput(form));
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const errorFor = (field: Field) => localErrors[field] ?? apiError?.fieldError(field);
  const fieldErrors = (["businessName", "industry", "country", "plan", "ownerName", "email", "password", "acceptTerms"] as const).some(
    (f) => apiError?.fieldError(f),
  );
  const formError = mutation.isError && !fieldErrors ? errorMessage(mutation.error) : null;
  const trialDays = config.data.trialDays;

  return (
    <AuthLayout title="Creá la cuenta de tu negocio" intro={`Probalo gratis ${trialDays} días. No te pedimos tarjeta para empezar.`}>
      <form onSubmit={onSubmit} noValidate>
        <TextField
          label="Nombre del negocio"
          name="businessName"
          autoComplete="organization"
          required
          value={form.businessName}
          error={errorFor("businessName")}
          onChange={(e) => set("businessName", e.target.value)}
        />
        <SelectField label="Rubro" name="industry" value={form.industry} options={INDUSTRY_OPTIONS} error={errorFor("industry")} onChange={(e) => set("industry", e.target.value)} />
        <SelectField
          label="País"
          name="country"
          value={form.country}
          options={COUNTRY_OPTIONS}
          hint="De acá salen la zona horaria y la moneda; las podés cambiar después en Configuración."
          error={errorFor("country")}
          onChange={(e) => set("country", e.target.value)}
        />
        <SelectField label="Plan" name="plan" value={form.plan} options={PLAN_OPTIONS} error={errorFor("plan")} onChange={(e) => set("plan", e.target.value as Plan)} />
        <TextField label="Tu nombre" name="ownerName" autoComplete="name" required value={form.ownerName} error={errorFor("ownerName")} onChange={(e) => set("ownerName", e.target.value)} />
        <TextField
          label="Correo"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={form.email}
          error={errorFor("email")}
          onChange={(e) => set("email", e.target.value)}
        />
        <PasswordField
          label="Clave"
          name="password"
          autoComplete="new-password"
          required
          hint={`Al menos ${MIN_PASSWORD_LENGTH} caracteres.`}
          value={form.password}
          error={errorFor("password")}
          onChange={(e) => set("password", e.target.value)}
        />
        <label className="signup-terms">
          <input type="checkbox" checked={form.acceptTerms} onChange={(e) => set("acceptTerms", e.target.checked)} aria-invalid={errorFor("acceptTerms") ? true : undefined} />
          <span>
            Acepto los{" "}
            <a href="/terminos" target="_blank" rel="noreferrer" className="link">
              términos
            </a>{" "}
            y el{" "}
            <a href="/privacidad" target="_blank" rel="noreferrer" className="link">
              aviso de privacidad
            </a>
            .
          </span>
        </label>
        {errorFor("acceptTerms") && <p className="field-error">{errorFor("acceptTerms")}</p>}
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Creando tu cuenta…" : "Crear mi cuenta"}
        </button>
        <Link to="/login" className="link auth-secondary">
          Ya tengo cuenta
        </Link>
      </form>
    </AuthLayout>
  );
}
