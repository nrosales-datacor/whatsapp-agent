import { useQuery } from "@tanstack/react-query";
import { adminListarTenants } from "../../api";

// Tabla de negocios ya dados de alta (resumen liviano, sin secretos). Se refresca
// sola cuando el formulario invalida ["adminTenants"] tras crear uno.
export default function ListaNegocios() {
  const q = useQuery({ queryKey: ["adminTenants"], queryFn: adminListarTenants });
  const tenants = q.data ?? [];

  return (
    <div className="card">
      <h3>Negocios ({tenants.length})</h3>
      {q.isLoading ? (
        <div className="admin-vacio">Cargando…</div>
      ) : q.isError ? (
        <div className="admin-error">No se pudieron cargar los negocios.</div>
      ) : tenants.length === 0 ? (
        <div className="admin-vacio">Todavía no hay negocios dados de alta.</div>
      ) : (
        <div className="admin-tabla-scroll">
          <table className="admin-tabla">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>id</th>
                <th>phone_number_id</th>
                <th>Servicios</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.nombre}</td>
                  <td>{t.id}</td>
                  <td>{t.phoneNumberId}</td>
                  <td>{t.servicios}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
