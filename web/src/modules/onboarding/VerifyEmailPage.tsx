import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useSetSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { FormError, TextField } from "../../ui/Field";
import FullPageStatus from "../../ui/FullPageStatus";
import AuthLayout from "../auth/AuthLayout";
import { resendVerification, verifySignup } from "./onboardingApi";
import "./onboarding.css";

/**
 * Confirmación del correo del alta (`/verify-email?token=…`, el enlace del correo): verifica,
 * deja la sesión iniciada y lleva al Inicio (con la checklist de primeros pasos). El enlace
 * es de un solo uso: se manda UNA vez por montaje (el modo estricto de React monta dos
 * veces en desarrollo). Si venció, se puede pedir otro.
 */
export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const setSession = useSetSession();
  const sent = useRef(false);
  const verify = useMutation({
    mutationFn: (value: string) => verifySignup(value),
    onSuccess: (me) => {
      setSession(me);
      navigate("/", { replace: true });
    },
  });

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    verify.mutate(token);
  }, [token, verify]);

  if (token && (verify.isIdle || verify.isPending || verify.isSuccess)) return <FullPageStatus message="Confirmando tu correo…" />;
  return <ExpiredLink message={verify.isError ? errorMessage(verify.error) : "Al enlace le falta información."} />;
}

function ExpiredLink({ message }: { message: string }) {
  const [email, setEmail] = useState("");
  const resend = useMutation({ mutationFn: (value: string) => resendVerification(value) });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!resend.isPending && email.trim()) resend.mutate(email.trim());
  }

  return (
    <AuthLayout title="El enlace no es válido" intro={`${message} Escribí tu correo y te mandamos uno nuevo.`}>
      {resend.isSuccess ? (
        <p className="auth-done" role="status">
          Si <strong>{email.trim()}</strong> tiene una cuenta pendiente de confirmar, te llega un enlace nuevo.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <TextField label="Correo" name="email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <FormError message={resend.isError ? errorMessage(resend.error) : null} />
          <button type="submit" className="btn btn-primary btn-block" disabled={resend.isPending}>
            {resend.isPending ? "Enviando…" : "Mandarme un enlace nuevo"}
          </button>
        </form>
      )}
      <Link to="/login" className="link auth-secondary">
        Ir a ingresar
      </Link>
    </AuthLayout>
  );
}
