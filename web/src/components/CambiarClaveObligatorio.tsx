import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cambiarClave } from "../api";

// Reset de contraseña desde el admin (Carril D, 0.5): cuando /me trae debeCambiarClave,
// App.tsx pinta esto en vez de <Panel> — el usuario no puede usar el panel hasta que
// cambie la clave temporal por una propia. Reusa los estilos de #login (mismo look).
export default function CambiarClaveObligatorio() {
  const qc = useQueryClient();
  const [claveActual, setClaveActual] = useState("");
  const [claveNueva, setClaveNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [validacion, setValidacion] = useState("");

  const cambiar = useMutation({
    mutationFn: () => cambiarClave(claveActual, claveNueva),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const error = validacion || (cambiar.isError ? (cambiar.error instanceof Error ? cambiar.error.message : "No se pudo cambiar la clave") : "");

  function alEnviar() {
    if (claveNueva.length < 8) {
      setValidacion("La contraseña nueva debe tener al menos 8 caracteres");
      return;
    }
    if (claveNueva !== confirmar) {
      setValidacion("Las contraseñas nuevas no coinciden");
      return;
    }
    setValidacion("");
    cambiar.mutate();
  }

  return (
    <div id="login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          alEnviar();
        }}
      >
        <div className="marca">
          <span className="marca-chip" aria-hidden="true">LR</span>
          <span className="marca-txt">Panel de atención</span>
        </div>
        <h1>Cambiá tu clave</h1>
        <p>Tu administrador te reseteó la contraseña. Por seguridad, elegí una nueva antes de continuar.</p>
        <label htmlFor="claveActual">Clave temporal</label>
        <input
          id="claveActual"
          type="password"
          autoComplete="current-password"
          required
          value={claveActual}
          onChange={(e) => setClaveActual(e.target.value)}
        />
        <label htmlFor="claveNueva">Clave nueva</label>
        <input
          id="claveNueva"
          type="password"
          autoComplete="new-password"
          required
          value={claveNueva}
          onChange={(e) => setClaveNueva(e.target.value)}
        />
        <label htmlFor="claveConfirmar">Confirmar clave nueva</label>
        <input
          id="claveConfirmar"
          type="password"
          autoComplete="new-password"
          required
          value={confirmar}
          onChange={(e) => setConfirmar(e.target.value)}
        />
        <button type="submit" disabled={cambiar.isPending}>
          {cambiar.isPending ? "Cambiando…" : "Cambiar clave →"}
        </button>
        <div id="loginError">{error}</div>
      </form>
    </div>
  );
}
