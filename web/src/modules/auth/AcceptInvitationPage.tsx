import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { homePathFor, roleLabel } from "../../app/navigation";
import { useSetSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { DEFAULT_TERMINOLOGY } from "../../lib/contract";
import { FormError, PasswordField, TextField } from "../../ui/Field";
import FullPageStatus from "../../ui/FullPageStatus";
import AuthLayout from "./AuthLayout";
import { acceptInvitation, getInvitation } from "./authApi";
import { usePasswordPair } from "./usePasswordPair";

/**
 * Aceptar una invitación (`/invite/:token`): el profesional o la recepcionista elige su
 * nombre y su clave, y entra directo al negocio que lo invitó.
 */
export default function AcceptInvitationPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const setSession = useSetSession();
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const pair = usePasswordPair();

  const invitation = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => getInvitation(token),
    enabled: token !== "",
  });

  const mutation = useMutation({
    mutationFn: () => acceptInvitation(token, name.trim(), pair.password),
    onSuccess: (me) => {
      setSession(me);
      navigate(homePathFor(me), { replace: true });
    },
  });

  if (!token || invitation.isError) {
    const notFound = !token || (isApiError(invitation.error) && invitation.error.status >= 400 && invitation.error.status < 500);
    return (
      <AuthLayout
        title={notFound ? "Esta invitación no está disponible" : "No pudimos cargar la invitación"}
        intro={
          notFound
            ? "Puede que haya vencido o que ya se haya usado. Pedile a quien te invitó que te mande una nueva."
            : errorMessage(invitation.error)
        }
      >
        {!notFound && (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => void invitation.refetch()}>
            Reintentar
          </button>
        )}
        <Link to="/login" className="link auth-secondary">
          Ir a ingresar
        </Link>
      </AuthLayout>
    );
  }

  const data = invitation.data;
  if (!data) return <FullPageStatus message="Buscando tu invitación…" />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const nameOk = name.trim() !== "";
    setNameMissing(!nameOk);
    const passwordOk = pair.validate();
    if (mutation.isPending || !nameOk || !passwordOk) return;
    mutation.mutate();
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const nameError = (nameMissing ? "Escribí tu nombre." : undefined) ?? apiError?.fieldError("name");
  const passwordServerError = apiError?.fieldError("password");
  const formError = mutation.isError && !apiError?.fieldError("name") && !passwordServerError ? errorMessage(mutation.error) : null;

  return (
    <AuthLayout
      title={`Sumate a ${data.businessName}`}
      intro={
        <>
          Te invitaron como <strong>{roleLabel(data.role, DEFAULT_TERMINOLOGY)}</strong>. Elegí tu nombre y una clave para
          entrar.
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Correo" name="email" type="email" autoComplete="username" value={data.email} readOnly />
        <TextField
          label="Tu nombre"
          name="name"
          autoComplete="name"
          required
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <PasswordField
          label="Clave"
          name="password"
          autoComplete="new-password"
          required
          value={pair.password}
          hint={pair.hint}
          error={pair.passwordError ?? passwordServerError}
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
          {mutation.isPending ? "Creando tu cuenta…" : "Aceptar invitación"}
        </button>
      </form>
    </AuthLayout>
  );
}
