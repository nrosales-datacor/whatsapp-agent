import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminCambiarPlan, adminListarTenants, type Plan } from "../../api";

// Tabla de negocios ya dados de alta (resumen liviano, sin secretos). Se refresca
// sola cuando el formulario invalida ["adminTenants"] tras crear uno.
export default function ListaNegocios() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["adminTenants"], queryFn: adminListarTenants });
  const tenants = q.data ?? [];

  const cambiarPlan = useMutation({
    mutationFn: ({ id, plan }: { id: string; plan: Plan }) => adminCambiarPlan(id, plan),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminTenants"] }),
  });

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
                <th>Plan</th>
                <th>Conversaciones este mes</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.nombre}</td>
                  <td>{t.id}</td>
                  <td>{t.phoneNumberId}</td>
                  <td>{t.servicios}</td>
                  <td>
                    <select
                      value={t.plan}
                      disabled={cambiarPlan.isPending}
                      onChange={(e) => cambiarPlan.mutate({ id: t.id, plan: e.target.value as Plan })}
                    >
                      <option value="basico">Básico</option>
                      <option value="pro">Pro</option>
                    </select>
                  </td>
                  <td>{t.conversacionesEsteMes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
