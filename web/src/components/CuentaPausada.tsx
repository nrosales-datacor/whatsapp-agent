import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logout } from "../api";

// Mismo canal de soporte que el Login (único contacto real que existe hoy).
const WA_SOPORTE = "50683658231";
const LINK_SOPORTE = `https://wa.me/${WA_SOPORTE}?text=${encodeURIComponent("Hola, mi cuenta del panel aparece pausada")}`;

// Pantalla para el dueño/operador de un negocio PAUSADO por la plataforma (cobro manual,
// PROCESO-COBRO-MANUAL.md): en vez de un login fallido o un error genérico, explica qué
// pasa y a quién escribir. Reusa el layout del login (#login) para no sumar estilos.
export default function CuentaPausada() {
  const qc = useQueryClient();
  const salir = useMutation({
    mutationFn: logout,
    onSettled: () => qc.setQueryData(["me"], null),
  });

  return (
    <div className="login-shell">
      <div id="login">
        <form onSubmit={(e) => e.preventDefault()}>
          <h1>Cuenta pausada</h1>
          <p>
            El asistente de este negocio está pausado por el momento y no está respondiendo a tus clientes. Los mensajes
            que lleguen se siguen guardando y vas a poder verlos apenas se reactive la cuenta.
          </p>
          <p>Para reactivarla, contactá a Selyon.</p>
          <a className="login-ayuda" href={LINK_SOPORTE} target="_blank" rel="noopener noreferrer">
            Escribir a Selyon por WhatsApp
          </a>
          <button type="button" className="btn-ghost" onClick={() => salir.mutate()} disabled={salir.isPending}>
            Salir
          </button>
        </form>
      </div>
    </div>
  );
}
