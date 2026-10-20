import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { errorMessage, isApiError } from "../../lib/api";
import { FormError, PasswordField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import AuthLayout from "./AuthLayout";
import { resetPassword } from "./authApi";
import { usePasswordPair } from "./usePasswordPair";

/** Crear clave nueva desde el enlace del correo (`/reset-password?token=…`). */
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const pair = usePasswordPair();
  const mutation = useMutation({ mutationFn: (password: string) => resetPassword(token, password) });

  if (!token) {
    return (
      <AuthLayout title="El enlace no es válido" intro="Le falta información. Pedí uno nuevo y abrilo desde el correo más reciente.">
        <Link to="/forgot-password" className="btn btn-primary btn-block">
          Pedir un enlace nuevo
        </Link>
      </AuthLayout>
    );
  }

  if (mutation.isSuccess) {
    return (
      <AuthLayout title="Listo, tu clave quedó cambiada">
        <div className="auth-done" role="status">
          <div className="empty-state-icon">
            <Icon id="check" size={24} strokeWidth={2} />
          </div>
          <p>Ya podés ingresar con tu clave nueva.</p>
        </div>
        <Link to="/login" className="btn btn-primary btn-block">
          Ingresar
        </Link>
      </AuthLayout>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending || !pair.validate()) return;
    mutation.mutate(pair.password);
  }

  const serverFieldError = isApiError(mutation.error) ? mutation.error.fieldError("password") : undefined;
  const formError = mutation.isError && !serverFieldError ? errorMessage(mutation.error) : null;
  // `invalid_token`: el enlace venció o ya se usó → se ofrece pedir otro.
  const tokenProblem = isApiError(mutation.error, "invalid_token");

  return (
    <AuthLayout title="Creá tu clave nueva" intro="Elegí una clave que no uses en otros sitios.">
      <form onSubmit={onSubmit} noValidate>
        <PasswordField
          label="Clave nueva"
          name="password"
          autoComplete="new-password"
          required
          value={pair.password}
          hint={pair.hint}
          error={pair.passwordError ?? serverFieldError}
          onChange={(e) => pair.setPassword(e.target.value)}
        />
        <PasswordField
          label="Repetí la clave"
          name="confirm"
          autoComplete="new-password"
          required
          value={pair.confirm}
          error={pair.confirmError}
          onChange={(e) => pair.setConfirm(e.target.value)}
        />
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar clave"}
        </button>
        {tokenProblem && (
          <Link to="/forgot-password" className="link auth-secondary">
            Pedir un enlace nuevo
          </Link>
        )}
      </form>
    </AuthLayout>
  );
}
