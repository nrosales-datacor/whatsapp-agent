import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { homePathFor } from "../../app/navigation";
import { fetchMe, ME_QUERY_KEY, useLogout, useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { FormError, PasswordField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import AuthLayout from "./AuthLayout";
import { changePassword } from "./authApi";
import { usePasswordPair } from "./usePasswordPair";

/**
 * Cambiar la clave (`/change-password`). Es obligatorio cuando la cuenta tiene una clave
 * temporal (`mustChangePassword`): la guarda de sesión no deja ver el panel hasta hacerlo.
 */
export default function ChangePasswordPage() {
  const me = useSession();
  const forced = me.user.mustChangePassword;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();
  const { showToast } = useToast();
  const [current, setCurrent] = useState("");
  const pair = usePasswordPair();

  const mutation = useMutation({
    mutationFn: () => changePassword(current, pair.password),
    onSuccess: async () => {
      // El Me nuevo ya no trae mustChangePassword (si la sesión se cerró, cae al login).
      const fresh = await qc.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 0 });
      showToast("Listo, tu clave quedó cambiada.");
      if (fresh) navigate(homePathFor(fresh), { replace: true });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending || !pair.validate() || !current) return;
    mutation.mutate();
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const currentError = apiError?.fieldError("currentPassword");
  const newError = apiError?.fieldError("newPassword");
  const formError = mutation.isError && !currentError && !newError ? errorMessage(mutation.error) : null;

  return (
    <AuthLayout
      title={forced ? "Elegí una clave nueva" : "Cambiar clave"}
      intro={
        forced
          ? "Estás entrando con una clave temporal. Por seguridad, elegí una propia antes de seguir."
          : "Escribí tu clave actual y la nueva."
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <PasswordField
          label={forced ? "Clave temporal" : "Clave actual"}
          name="currentPassword"
          autoComplete="current-password"
          required
          value={current}
          error={currentError}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <PasswordField
          label="Clave nueva"
          name="newPassword"
          autoComplete="new-password"
          required
          value={pair.password}
          hint={pair.hint}
          error={pair.passwordError ?? newError}
          onChange={(e) => pair.setPassword(e.target.value)}
        />
        <PasswordField
          label="Repetí la clave nueva"
          name="confirm"
          autoComplete="new-password"
          required
          value={pair.confirm}
          error={pair.confirmError}
          onChange={(e) => pair.setConfirm(e.target.value)}
        />
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending || !current}>
          {mutation.isPending ? "Guardando…" : "Guardar clave"}
        </button>
        {forced ? (
          <button type="button" className="link-button auth-secondary" onClick={() => logout.mutate()}>
            Salir
          </button>
        ) : (
          <Link to={homePathFor(me)} className="link auth-secondary">
            Volver al panel
          </Link>
        )}
      </form>
    </AuthLayout>
  );
}
