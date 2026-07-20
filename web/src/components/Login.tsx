import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { login } from "../api";
import Icono from "./Iconos";

// Único canal de contacto real que existe hoy en todo el producto (el mismo
// wa.me que usa la landing para ventas/soporte) — no hay backend de recuperación
// de contraseña ni de soporte por email, así que estos links van al mismo lugar
// donde HOY se resuelve manualmente ("escribile a Sebastián/Nathan y te resetean
// el hash"), en vez de prometer un flujo que no existe.
const WA_SOPORTE = "50683658231";
function linkSoporte(mensaje: string): string {
  return `https://wa.me/${WA_SOPORTE}?text=${encodeURIComponent(mensaje)}`;
}

// Pantalla de login. Al entrar, invalida ["me"] → <App> revalida la sesión y pasa
// al panel. El error del backend (usuario/clave) llega como ApiError.message.
export default function Login() {
  const qc = useQueryClient();
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [mostrarPassword, setMostrarPassword] = useState(false);

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
    <div className="login-shell">
      <div className="login-marca">
        <div className="login-marca-brand">
          <span className="marca-chip" aria-hidden="true">LR</span>
          <span className="login-marca-nombre">Panel de atención</span>
        </div>
        <div>
          <h2 className="login-marca-titular">Tu asistente atiende, cotiza y agenda por vos.</h2>
          <p className="login-marca-sub">
            Un agente de WhatsApp con IA que responde a tus clientes, cotiza servicios y agenda citas — mientras vos
            hacés otras cosas.
          </p>
        </div>
        <div className="login-marca-footer">© {new Date().getFullYear()} · Panel de atención</div>
      </div>

      <div id="login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            entrar.mutate();
          }}
        >
          <div className="marca login-marca-movil">
            <span className="marca-chip" aria-hidden="true">LR</span>
            <span className="marca-txt">Panel de atención</span>
          </div>
          <h1>Ingresá a tu panel</h1>
          <p>Ingresá para responder a tus clientes y ver las métricas de tu negocio.</p>
          <label htmlFor="usuario">Usuario</label>
          <input
            id="usuario"
            autoComplete="username"
            placeholder="ej: mi-negocio"
            required
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
          />
          <div className="login-pass-label-row">
            <label htmlFor="password">Contraseña</label>
            <a
              className="login-link"
              href={linkSoporte("Hola, olvidé mi contraseña del panel")}
              target="_blank"
              rel="noopener noreferrer"
            >
              ¿La olvidaste?
            </a>
          </div>
          <div className="login-pass-wrap">
            <input
              id="password"
              type={mostrarPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="login-pass-toggle"
              onClick={() => setMostrarPassword((m) => !m)}
              aria-label={mostrarPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              title={mostrarPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            >
              <Icono id={mostrarPassword ? "eyeoff" : "eye"} size={18} />
            </button>
          </div>
          <button type="submit" disabled={entrar.isPending}>
            {entrar.isPending ? "Entrando…" : "Entrar →"}
          </button>
          <div id="loginError">{error}</div>
          <a
            className="login-ayuda"
            href={linkSoporte("Hola, tengo problemas para entrar al panel")}
            target="_blank"
            rel="noopener noreferrer"
          >
            ¿Problemas para entrar? Escribinos
          </a>
        </form>
      </div>
    </div>
  );
}
