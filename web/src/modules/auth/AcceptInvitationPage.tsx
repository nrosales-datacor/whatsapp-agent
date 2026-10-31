import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { homePathFor, roleLabel } from "../../app/navigation";
import { useSetSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { DEFAULT_TERMINOLOGY, type AcceptInvitationInput, type Invitation } from "../../lib/contract";
import { FormError, PasswordField, TextField } from "../../ui/Field";
import FullPageStatus from "../../ui/FullPageStatus";
import AuthLayout from "./AuthLayout";
import { acceptInvitation, getInvitation } from "./authApi";
import TermsConsent, { TERMS_REQUIRED_MESSAGE } from "./TermsConsent";
import { usePasswordPair } from "./usePasswordPair";

// ─────────────────────────────────────────────────────────────────────────────
// Aceptar una invitación al equipo (`/accept-invitation?token=…`, el enlace del correo).
//
//   • Cuenta nueva (`hasAccount: false`): elige su nombre y una clave.
//   • Cuenta que ya existe (está en otro negocio): confirma con SU clave actual, y con el
//     código de su app si tiene 2FA (el backend lo pide con 400 `totp_required`). El
//     enlace nunca sirve para cambiarle la clave a nadie.
//
// En los dos casos la persona acepta los términos y el aviso de privacidad vigentes (la
// casilla es obligatoria; el backend guarda la versión y la fecha). Al aceptar, la sesión
// queda abierta en el negocio que invitó.
// ─────────────────────────────────────────────────────────────────────────────

/** Alias viejo `/invite/:token` → `/accept-invitation?token=…`. */
export function InviteRedirect() {
  const { token = "" } = useParams();
  return <Navigate to={`/accept-invitation?token=${encodeURIComponent(token)}`} replace />;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export default function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get("token")?.trim() ?? "";

  const invitation = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => getInvitation(token),
    enabled: token !== "",
  });

  if (!token || invitation.isError) {
    const unavailable = !token || (isApiError(invitation.error) && invitation.error.status >= 400 && invitation.error.status < 500);
    return (
      <AuthLayout
        title={unavailable ? "Esta invitación no está disponible" : "No pudimos cargar la invitación"}
        intro={
          unavailable
            ? "Puede que haya vencido o que ya se haya usado. Pedile a quien te invitó que te mande una nueva."
            : errorMessage(invitation.error)
        }
      >
        {!unavailable && (
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

  if (!invitation.data) return <FullPageStatus message="Buscando tu invitación…" />;
  return invitation.data.hasAccount ? (
    <ExistingAccountForm token={token} invitation={invitation.data} />
  ) : (
    <NewAccountForm token={token} invitation={invitation.data} />
  );
}

interface FormProps {
  token: string;
  invitation: Invitation;
}

/** Acepta y abre la sesión en el negocio que invitó. */
function useAccept() {
  const navigate = useNavigate();
  const setSession = useSetSession();
  return useMutation({
    mutationFn: (input: AcceptInvitationInput) => acceptInvitation(input),
    onSuccess: (me) => {
      setSession(me);
      navigate(homePathFor(me), { replace: true });
    },
  });
}

/** Cuenta nueva: nombre + clave (con confirmación). */
function NewAccountForm({ token, invitation }: FormProps) {
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [termsMissing, setTermsMissing] = useState(false);
  const pair = usePasswordPair();
  const mutation = useAccept();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const nameOk = name.trim() !== "";
    setNameMissing(!nameOk);
    setTermsMissing(!acceptTerms);
    const passwordOk = pair.validate();
    if (mutation.isPending || !nameOk || !passwordOk || !acceptTerms) return;
    mutation.mutate({ token, name: name.trim(), password: pair.password, acceptTerms: true });
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const nameServerError = apiError?.fieldError("name");
  const passwordServerError = apiError?.fieldError("password");
  const termsServerError = apiError?.fieldError("acceptTerms");
  const nameError = (nameMissing ? "Escribí tu nombre." : undefined) ?? nameServerError;
  const termsError = (termsMissing ? TERMS_REQUIRED_MESSAGE : undefined) ?? termsServerError;
  const formError = mutation.isError && !nameServerError && !passwordServerError && !termsServerError ? errorMessage(mutation.error) : null;

  return (
    <AuthLayout
      title={`Sumate a ${invitation.businessName}`}
      intro={
        <>
          Te invitaron como <strong>{roleLabel(invitation.role, DEFAULT_TERMINOLOGY)}</strong>. Elegí tu nombre y una clave
          para entrar.
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Correo" name="email" type="email" autoComplete="username" value={invitation.email} readOnly />
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
        <TermsConsent
          checked={acceptTerms}
          error={termsError}
          onChange={(checked) => {
            setAcceptTerms(checked);
            setTermsMissing(false);
          }}
        />
        <FormError message={formError} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Creando tu cuenta…" : "Aceptar invitación"}
        </button>
      </form>
    </AuthLayout>
  );
}

/** Cuenta existente: confirma con su clave actual (y el código de 2FA si lo pide). */
function ExistingAccountForm({ token, invitation }: FormProps) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [termsMissing, setTermsMissing] = useState(false);
  const totpRef = useRef<HTMLInputElement>(null);
  const mutation = useAccept();

  // El backend pide el código recién después de validar la clave (400 `totp_required`).
  useEffect(() => {
    if (isApiError(mutation.error, "totp_required")) setNeedsTotp(true);
  }, [mutation.error]);
  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTermsMissing(!acceptTerms);
    if (mutation.isPending || !password || (needsTotp && totpCode.length < 6) || !acceptTerms) return;
    mutation.mutate({ token, password, acceptTerms: true, ...(needsTotp ? { totpCode } : {}) });
  }

  const error = mutation.error;
  const passwordError = isApiError(error, "invalid_password") ? error.message : undefined;
  const codeError = isApiError(error, "invalid_code") ? error.message : undefined;
  const termsServerError = isApiError(error) ? error.fieldError("acceptTerms") : undefined;
  const termsError = (termsMissing ? TERMS_REQUIRED_MESSAGE : undefined) ?? termsServerError;
  const formError =
    mutation.isError && !passwordError && !codeError && !termsServerError && !isApiError(error, "totp_required") ? errorMessage(error) : null;

  return (
    <AuthLayout
      title={`Sumate a ${invitation.businessName}`}
      intro={
        <>
          Te invitaron como <strong>{roleLabel(invitation.role, DEFAULT_TERMINOLOGY)}</strong>. Ya tenés una cuenta con
          este correo: confirmá con la clave con la que ya entrás.
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Correo" name="email" type="email" autoComplete="username" value={invitation.email} readOnly />
        <PasswordField
          label="Tu clave actual"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.target.value)}
          labelAside={
            <Link to="/forgot-password" className="link">
              ¿La olvidaste?
            </Link>
          }
        />
        {needsTotp && (
          <TextField
            ref={totpRef}
            label="Código de verificación"
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            hint="El código de 6 dígitos de tu app de autenticación."
            value={totpCode}
            error={codeError}
            onChange={(e) => setTotpCode(onlyDigits(e.target.value))}
          />
        )}
        <TermsConsent
          checked={acceptTerms}
          error={termsError}
          onChange={(checked) => {
            setAcceptTerms(checked);
            setTermsMissing(false);
          }}
        />
        <FormError message={formError} />
        <button
          type="submit"
          className="btn btn-primary btn-block btn-lg"
          disabled={mutation.isPending || !password || (needsTotp && totpCode.length < 6)}
        >
          {mutation.isPending ? "Verificando…" : "Aceptar invitación"}
        </button>
      </form>
    </AuthLayout>
  );
}
