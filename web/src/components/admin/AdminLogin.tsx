import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminLogin } from "../../api";

// Login del superadmin (credencial por .env). Al entrar invalida ["adminMe"] → Onboarding.
export default function AdminLogin() {
  const qc = useQueryClient();
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");

  const entrar = useMutation({
    mutationFn: () => adminLogin(usuario.trim(), password),
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
          <button type="submit" disabled={entrar.isPending}>
            {entrar.isPending ? "Entrando…" : "Entrar"}
          </button>
          <div className="admin-error">{error}</div>
        </form>
      </div>
    </div>
  );
}
