import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorMessage, isApiError } from "../../lib/api";
import { FormError, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import AuthLayout from "./AuthLayout";
import { forgotPassword } from "./authApi";

/**
 * Recuperar clave (`POST /auth/password/forgot`). La respuesta es la misma exista o no la
 * cuenta (el backend no revela qué correos están registrados), y el texto lo respeta.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const mutation = useMutation({ mutationFn: (value: string) => forgotPassword(value) });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mutation.isPending) mutation.mutate(email.trim());
  }

  if (mutation.isSuccess) {
    return (
      <AuthLayout title="Revisá tu correo">
        <div className="auth-done" role="status">
          <div className="empty-state-icon">
            <Icon id="mail" size={24} strokeWidth={1.6} />
          </div>
          <p>
            Si <strong>{email.trim()}</strong> tiene una cuenta, te llega un enlace para crear una clave nueva. Revisá
            también la carpeta de correo no deseado.
          </p>
        </div>
        <Link to="/login" className="btn btn-secondary btn-block">
          Volver a ingresar
        </Link>
      </AuthLayout>
    );
  }

  const emailError = isApiError(mutation.error) ? mutation.error.fieldError("email") : undefined;
  const formError = mutation.isError && !emailError ? errorMessage(mutation.error) : null;

  return (
    <AuthLayout title="¿Olvidaste tu clave?" intro="Escribí el correo con el que entrás y te mandamos un enlace para crear una nueva.">
      <form onSubmit={onSubmit}>
        <TextField
          label="Correo"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Enviando…" : "Enviar enlace"}
        </button>
        <Link to="/login" className="link auth-secondary">
          Volver a ingresar
        </Link>
      </form>
    </AuthLayout>
  );
}
