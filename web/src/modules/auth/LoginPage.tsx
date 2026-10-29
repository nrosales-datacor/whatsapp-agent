import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { homePathFor } from "../../app/navigation";
import { fetchMe, ME_QUERY_KEY, useSetSession, type LoginRedirectState } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import type { LoginInput } from "../../lib/contract";
import { FormError, PasswordField, TextField } from "../../ui/Field";
import AuthLayout from "./AuthLayout";
import { getSignupConfig, login, resendVerification, SIGNUP_CONFIG_QUERY_KEY } from "./authApi";

function loginErrorMessage(error: unknown, step: "credentials" | "totp"): string {
  // En el paso del código, el backend responde el mismo `invalid_credentials` (no revela
  // qué parte falló), pero acá lo único que cambió es el código.
  if (step === "totp" && isApiError(error, "invalid_credentials")) {
    return "El código no es correcto. Probá con el que muestra la app ahora.";
  }
  // `no_active_business`, `too_many_attempts`, `invalid_credentials`…: el mensaje del backend.
  return errorMessage(error, "No pudimos iniciar sesión. Probá de nuevo.");
}

/**
 * Login por email (`POST /auth/login`). Si la cuenta tiene 2FA, el backend responde
 * `totp_required` y se pide el código en un segundo paso con las mismas credenciales.
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useSetSession();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const totpRef = useRef<HTMLInputElement>(null);
  // Alta self-service (I6.7): el link "Crear una cuenta" solo si está abierta en el backend.
  const signupConfig = useQuery({ queryKey: SIGNUP_CONFIG_QUERY_KEY, queryFn: getSignupConfig, staleTime: 60_000, retry: false });
  const resend = useMutation({ mutationFn: (value: string) => resendVerification(value) });

  const mutation = useMutation({
    mutationFn: (input: LoginInput) => login(input),
    onSuccess: async (result) => {
      if (result.status === "totp_required") {
        setStep("totp");
        return;
      }
      // El contrato trae el Me en la respuesta; si no viniera, se pide aparte.
      const me = result.me ?? (await qc.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 0 }));
      if (!me) return;
      setSession(me);
      const from = (location.state as LoginRedirectState | null)?.from;
      navigate(from && from !== "/login" ? from : homePathFor(me), { replace: true });
    },
    onError: async (error) => {
      // Pausado POR FALTA DE PAGO: el backend deja la sesión para pagar (403 + cookie). Si la
      // hay, "Cuenta pausada" ofrece pagar; si no (pausa del superadmin), queda el mensaje.
      if (!isApiError(error, "business_paused")) return;
      try {
        await qc.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 0 });
      } catch (e) {
        if (isApiError(e, "business_paused")) navigate("/", { replace: true });
      }
    },
  });

  useEffect(() => {
    if (step === "totp") totpRef.current?.focus();
  }, [step]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    mutation.mutate({
      email: email.trim(),
      password,
      ...(step === "totp" ? { totpCode: totpCode.trim() } : {}),
    });
  }

  function backToCredentials() {
    setStep("credentials");
    setTotpCode("");
    mutation.reset();
  }

  const error = mutation.isError ? loginErrorMessage(mutation.error, step) : null;

  if (step === "totp") {
    return (
      <AuthLayout title="Verificación en dos pasos" intro="Escribí el código de 6 dígitos que muestra tu app de autenticación.">
        <form onSubmit={onSubmit} noValidate>
          <TextField
            ref={totpRef}
            label="Código"
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
          />
          <FormError message={error} />
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending || totpCode.length < 6}>
            {mutation.isPending ? "Verificando…" : "Verificar y entrar"}
          </button>
          <button type="button" className="link-button auth-secondary" onClick={backToCredentials}>
            Usar otra cuenta
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Ingresá a tu panel" intro="Tu agenda, tus clientes y tu WhatsApp, en un solo lugar." showMockAccounts>
      <form onSubmit={onSubmit}>
        <TextField
          label="Correo"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Clave"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          labelAside={
            <Link to="/forgot-password" className="link">
              ¿La olvidaste?
            </Link>
          }
        />
        <FormError message={error} />
        {isApiError(mutation.error, "email_not_verified") && (
          <div className="auth-resend">
            {resend.isSuccess ? (
              <p role="status">Listo: te mandamos un enlace nuevo. Revisá tu correo.</p>
            ) : (
              <button type="button" className="btn btn-secondary btn-block" disabled={resend.isPending} onClick={() => resend.mutate(email.trim())}>
                {resend.isPending ? "Enviando…" : "Reenviar el enlace de confirmación"}
              </button>
            )}
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Entrando…" : "Entrar"}
        </button>
        {signupConfig.data?.enabled && (
          <p className="auth-signup">
            ¿Tu negocio todavía no tiene cuenta?{" "}
            <Link to="/signup" className="link">
              Crear una cuenta
            </Link>
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
