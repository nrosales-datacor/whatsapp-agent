import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "./authApi";

/**
 * Clave nueva + confirmación, con la validación local de siempre (largo mínimo y que
 * coincidan). Los errores aparecen recién después del primer intento de enviar.
 */
export function usePasswordPair() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm !== password;
  const passwordError = submitted && tooShort ? `Usá al menos ${MIN_PASSWORD_LENGTH} caracteres.` : undefined;
  const confirmError = submitted && !tooShort && mismatch ? "Las claves no coinciden." : undefined;

  return {
    password,
    setPassword,
    confirm,
    setConfirm,
    passwordError,
    confirmError,
    hint: `Al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    /** Marca el intento y dice si se puede mandar. */
    validate(): boolean {
      setSubmitted(true);
      return !tooShort && !mismatch;
    },
  };
}
