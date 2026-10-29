import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { errorMessage } from "../../lib/api";
import Icon from "../../ui/Icons";
import AuthLayout from "./AuthLayout";
import { verifyEmail } from "./authApi";

// El link vale UNA vez: un pedido por token aunque React monte la página dos veces (modo
// estricto en desarrollo) o se vuelva a renderizar. La segunda vez espera la misma promesa.
const attempts = new Map<string, Promise<void>>();

function confirmOnce(token: string): Promise<void> {
  let attempt = attempts.get(token);
  if (!attempt) {
    attempt = verifyEmail(token);
    attempts.set(token, attempt);
  }
  return attempt;
}

type Status = { kind: "pending" } | { kind: "done" } | { kind: "error"; message: string };

/**
 * Confirmar el correo (`/verify-email?token=`, el link que llega tras el alta self-service,
 * I6.7). Confirma al abrir y después lleva a ingresar. Un link usado o vencido se puede
 * pedir de nuevo desde el login.
 */
export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    confirmOnce(token).then(
      () => active && setStatus({ kind: "done" }),
      (error: unknown) => active && setStatus({ kind: "error", message: errorMessage(error) }),
    );
    return () => {
      active = false;
    };
  }, [token]);

  if (!token || status.kind === "error") {
    return (
      <AuthLayout title="El enlace no funciona">
        <div className="auth-done" role="alert">
          <div className="empty-state-icon empty-state-icon-danger">
            <Icon id="alert" size={24} strokeWidth={1.6} />
          </div>
          <p>{status.kind === "error" ? status.message : "Al enlace le falta una parte. Copialo completo desde el correo."}</p>
          <p>Si ya lo usaste, entrá con tu clave. Si venció, intentá entrar y pedí uno nuevo.</p>
        </div>
        <Link to="/login" className="btn btn-primary btn-block">
          Ir a ingresar
        </Link>
      </AuthLayout>
    );
  }

  if (status.kind === "pending") {
    return (
      <AuthLayout title="Confirmando tu correo…">
        <p className="auth-intro" role="status">
          Un momento.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="¡Correo confirmado!">
      <div className="auth-done" role="status">
        <div className="empty-state-icon">
          <Icon id="check" size={24} strokeWidth={1.6} />
        </div>
        <p>Tu cuenta está lista. Entrá con tu correo y tu clave para empezar a configurar tu negocio.</p>
      </div>
      <Link to="/login" className="btn btn-primary btn-block btn-lg">
        Ingresar
      </Link>
    </AuthLayout>
  );
}
