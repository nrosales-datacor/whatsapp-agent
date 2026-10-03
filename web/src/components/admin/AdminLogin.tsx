import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminLogin } from "../../api";

// Login del superadmin (credencial por .env). Al entrar invalida ["adminMe"] → Onboarding.
// Segundo factor (revisión de seguridad 2026-10): el código de 6 dígitos de la app
// autenticadora. El campo se muestra siempre; el server solo lo exige si tiene
// PANEL_SUPERADMIN_TOTP_SECRET configurado (no se le revela a nadie si el 2FA está activo).
export default function AdminLogin() {
  const qc = useQueryClient();
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [codigo, setCodigo] = useState("");

  const entrar = useMutation({
    mutationFn: () => adminLogin(usuario.trim(), password, codigo.replace(/\s/g, "")),
    // Un código TOTP no se puede reusar: tras un intento fallido se limpia el campo.
    onError: () => setCodigo(""),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminMe"] }),
  });

  const error = entrar.isError ? (entrar.error instanceof Error ? entrar.error.message : "No se pudo entrar") : "";

  return (
    <div id="admin">
      <div id="admin-login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            entrar.mutate();
          }}
        >
          <div className="marca">
            <span className="marca-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 13h4l2 3h4l2-3h4" />
                <path d="M5 6h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" />
              </svg>
            </span>
            <span className="marca-txt">Administración</span>
          </div>
          <h1>Onboarding</h1>
          <p>Acceso del administrador para dar de alta negocios nuevos.</p>
          <label htmlFor="admUsuario">Usuario</label>
          <input
            id="admUsuario"
            autoComplete="username"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            required
          />
          <label htmlFor="admPassword">Contraseña</label>
          <input
            id="admPassword"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <label htmlFor="admCodigo">Código de verificación</label>
          <input
            id="admCodigo"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            placeholder="6 dígitos de tu app autenticadora"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
          />
          <button type="submit" disabled={entrar.isPending}>
            {entrar.isPending ? "Entrando…" : "Entrar"}
          </button>
          <div className="admin-error">{error}</div>
        </form>
      </div>
    </div>
  );
}
