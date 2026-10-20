import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { errorMessage, isApiError } from "../../lib/api";
import type { AdminLoginInput } from "../../lib/contract";
import { FormError, PasswordField, TextField } from "../../ui/Field";
import AuthLayout from "../auth/AuthLayout";
import { ADMIN_ME_QUERY_KEY, adminLogin, fetchAdminMe } from "./adminApi";

/** Login del superadmin (usuario + clave, y el código de 2FA si lo pide). */
export default function AdminLoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const totpRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (input: AdminLoginInput) => adminLogin(input),
    onSuccess: async (result) => {
      if (result.status === "totp_required") {
        setStep("totp");
        return;
      }
      await qc.fetchQuery({ queryKey: ADMIN_ME_QUERY_KEY, queryFn: fetchAdminMe, staleTime: 0 });
      navigate("/admin", { replace: true });
    },
  });

  useEffect(() => {
    if (step === "totp") totpRef.current?.focus();
  }, [step]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    mutation.mutate({
      username: username.trim(),
      password,
      ...(step === "totp" ? { totpCode: totpCode.trim() } : {}),
    });
  }

  const error = mutation.isError
    ? isApiError(mutation.error, "too_many_attempts")
      ? mutation.error.message || "Demasiados intentos. Esperá unos minutos."
      : errorMessage(mutation.error, "No pudimos iniciar sesión.")
    : null;

  return (
    <AuthLayout title="Superadmin" intro={step === "totp" ? "Escribí el código de tu app de autenticación." : "Acceso de la plataforma."}>
      <form onSubmit={onSubmit} noValidate={step === "totp"}>
        {step === "credentials" ? (
          <>
            <TextField
              label="Usuario"
              name="username"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <PasswordField
              label="Clave"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : (
          <TextField
            ref={totpRef}
            label="Código"
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
          />
        )}
        <FormError message={error} />
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={mutation.isPending}>
          {mutation.isPending ? "Entrando…" : step === "totp" ? "Verificar y entrar" : "Entrar"}
        </button>
        {step === "totp" && (
          <button
            type="button"
            className="link-button auth-secondary"
            onClick={() => {
              setStep("credentials");
              setTotpCode("");
              mutation.reset();
            }}
          >
            Volver
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
