import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { login } from "../api";

// Pantalla de login. Al entrar, invalida ["me"] → <App> revalida la sesión y pasa
// al panel. El error del backend (usuario/clave) llega como ApiError.message.
export default function Login() {
  const qc = useQueryClient();
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");

  const entrar = useMutation({
    mutationFn: () => login(usuario.trim(), password),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const error = entrar.isError
    ? entrar.error instanceof Error
      ? entrar.error.message
      : "No se pudo entrar"
    : "";

  return (
    <div id="login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          entrar.mutate();
        }}
      >
        <div className="marca">
          <span className="marca-chip" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 13h4l2 3h4l2-3h4" />
              <path d="M5 6h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" />
            </svg>
          </span>
          <span className="marca-txt">Panel de atención</span>
        </div>
        <h1>Bandeja</h1>
        <p>Ingresá para responder a tus clientes y ver las métricas de tu negocio.</p>
        <label htmlFor="usuario">Negocio</label>
        <input
          id="usuario"
          autoComplete="username"
          placeholder="ej: lavacar-rosales"
          required
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
        />
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={entrar.isPending}>
          {entrar.isPending ? "Entrando…" : "Entrar"}
        </button>
        <div id="loginError">{error}</div>
      </form>
    </div>
  );
}
