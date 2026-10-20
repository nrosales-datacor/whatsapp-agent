import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError, PasswordField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { disableTotp, enableTotp, setupTotp } from "./authApi";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** "1234 5678 ABCD" — más fácil de copiar a mano en la app de autenticación. */
function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

/** Activar la verificación en dos pasos: generar el secreto, cargarlo en la app y confirmar con un código. */
function EnableTwoFactor({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [code, setCode] = useState("");
  const setup = useMutation({ mutationFn: setupTotp });
  const enable = useMutation({
    mutationFn: (value: string) => enableTotp(value),
    // Primero se cierra (si no, al refrescar la sesión el diálogo cambiaría al de desactivar).
    onSuccess: () => {
      onDone();
      showToast("Listo, la verificación en dos pasos quedó activada.");
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });

  if (!setup.data) {
    return (
      <div className="stack">
        <p>
          Además de tu clave, al entrar te vamos a pedir un código de 6 dígitos de una app de autenticación (Google
          Authenticator, Microsoft Authenticator, 1Password…).
        </p>
        <FormError message={setup.isError ? errorMessage(setup.error) : null} />
        <button type="button" className="btn btn-primary btn-block" onClick={() => setup.mutate()} disabled={setup.isPending}>
          {setup.isPending ? "Preparando…" : "Empezar"}
        </button>
      </div>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enable.isPending && code.length === 6) enable.mutate(code);
  }

  const codeError = isApiError(enable.error) ? enable.error.fieldError("code") : undefined;
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <ol className="steps">
        <li>
          En tu app de autenticación, agregá una cuenta nueva con esta clave (o{" "}
          <a href={setup.data.otpauthUrl} className="link">
            abrila directo en la app
          </a>{" "}
          desde el celular):
          <code className="secret">{groupSecret(setup.data.secret)}</code>
        </li>
        <li>Escribí el código de 6 dígitos que te muestra la app.</li>
      </ol>
      <TextField
        label="Código"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        value={code}
        error={codeError}
        onChange={(e) => setCode(onlyDigits(e.target.value))}
      />
      <FormError message={enable.isError && !codeError ? errorMessage(enable.error) : null} />
      <button type="submit" className="btn btn-primary btn-block" disabled={enable.isPending || code.length < 6}>
        {enable.isPending ? "Activando…" : "Activar"}
      </button>
    </form>
  );
}

/** Desactivar la verificación en dos pasos: pide la clave y un código vigente. */
function DisableTwoFactor({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const disable = useMutation({
    mutationFn: () => disableTotp(password, code),
    onSuccess: () => {
      onDone();
      showToast("La verificación en dos pasos quedó desactivada.");
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!disable.isPending && password && code.length === 6) disable.mutate();
  }

  const apiError = isApiError(disable.error) ? disable.error : null;
  const passwordError = apiError?.fieldError("password");
  const codeError = apiError?.fieldError("code");
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <p>Tu cuenta va a quedar protegida solo con la clave. Para confirmar, escribí tu clave y un código de la app.</p>
      <PasswordField
        label="Clave"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        error={passwordError}
        onChange={(e) => setPassword(e.target.value)}
      />
      <TextField
        label="Código"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        value={code}
        error={codeError}
        onChange={(e) => setCode(onlyDigits(e.target.value))}
      />
      <FormError message={disable.isError && !passwordError && !codeError ? errorMessage(disable.error) : null} />
      <button type="submit" className="btn btn-danger btn-block" disabled={disable.isPending || !password || code.length < 6}>
        {disable.isPending ? "Desactivando…" : "Desactivar"}
      </button>
    </form>
  );
}

/** Diálogo de 2FA del menú de usuario (activar o desactivar según el estado de la cuenta). */
export default function TwoFactorDialog({ open, onClose }: Props) {
  const me = useSession();
  const enabled = me.user.totpEnabled;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={enabled ? "Desactivar verificación en dos pasos" : "Activar verificación en dos pasos"}
    >
      {enabled ? <DisableTwoFactor onDone={onClose} /> : <EnableTwoFactor onDone={onClose} />}
    </Dialog>
  );
}
