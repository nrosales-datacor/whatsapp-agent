import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminLogout, type AdminSesion } from "../../api";
import FormularioNegocio from "./FormularioNegocio";
import ListaNegocios from "./ListaNegocios";

// Área del superadmin: alta de negocios + lista de los existentes.
export default function Onboarding({ sesion }: { sesion: AdminSesion }) {
  const qc = useQueryClient();
  const salir = useMutation({
    mutationFn: adminLogout,
    onSettled: () => qc.setQueryData(["adminMe"], null),
  });

  return (
    <div id="admin">
      <div className="admin-header">
        <h2>Onboarding de negocios</h2>
        <span className="admin-user">{sesion.usuario}</span>
        <button type="button" className="btn-ghost" onClick={() => salir.mutate()}>
          Salir
        </button>
      </div>
      <div className="admin-body">
        {!sesion.hayDb && (
          <div className="admin-aviso">
            ⚠️ No hay base de datos configurada: el alta está deshabilitada. Esto solo funciona en producción
            (o en local con <code>DATABASE_URL</code>).
          </div>
        )}
        <FormularioNegocio hayDb={sesion.hayDb} />
        <ListaNegocios />
      </div>
    </div>
  );
}
