import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminCambiarPlan, adminListarTenants, adminListarUsuariosTenant, adminResetearClave, type Plan } from "../../api";
import ErrorState from "../ErrorState";

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

  // Detalle del negocio (Carril D, 0.5): solo un tenant expandido a la vez, muestra su
  // equipo con el botón "Resetear clave".
  const [expandido, setExpandido] = useState<string | null>(null);

  return (
    <div className="card">
      <h3>Negocios ({tenants.length})</h3>
      {q.isLoading ? (
        <div className="admin-vacio">Cargando…</div>
      ) : q.isError ? (
        <ErrorState mensaje="No se pudieron cargar los negocios." onReintentar={() => q.refetch()} />
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
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <Fragment key={t.id}>
                  <tr>
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
                    <td>
                      <button type="button" className="btn-ghost" onClick={() => setExpandido(expandido === t.id ? null : t.id)}>
                        {expandido === t.id ? "Ocultar" : "Ver equipo"}
                      </button>
                    </td>
                  </tr>
                  {expandido === t.id && (
                    <tr>
                      <td colSpan={7}>
                        <EquipoNegocio tenantId={t.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Equipo de un negocio + reset de clave (Carril D, 0.5): sin sistema de entrega
// automática todavía, la clave temporal se muestra en pantalla para que el
// superadmin la copie y se la comunique al dueño por su cuenta.
function EquipoNegocio({ tenantId }: { tenantId: string }) {
  const q = useQuery({ queryKey: ["adminUsuariosTenant", tenantId], queryFn: () => adminListarUsuariosTenant(tenantId) });
  const [resultado, setResultado] = useState<{ usuarioId: string; usuario: string; claveTemporal: string } | null>(null);

  const resetear = useMutation({
    mutationFn: (usuarioId: string) => adminResetearClave(usuarioId),
    onSuccess: (r, usuarioId) => setResultado({ usuarioId, usuario: r.usuario, claveTemporal: r.claveTemporal }),
  });

  const usuarios = q.data ?? [];

  if (q.isLoading) return <div className="admin-vacio">Cargando equipo…</div>;
  if (q.isError) return <ErrorState mensaje="No se pudo cargar el equipo." onReintentar={() => q.refetch()} />;
  if (usuarios.length === 0) return <div className="admin-vacio">Este negocio todavía no tiene usuarios de panel.</div>;

  return (
    <div>
      {resultado && (
        <div className="admin-ok">
          Clave temporal para <strong>{resultado.usuario}</strong>: <code>{resultado.claveTemporal}</code> (vence en 24h; el
          panel le va a pedir cambiarla al entrar). Copiala y comunicásela al dueño — no vuelve a mostrarse.
        </div>
      )}
      <table className="admin-tabla">
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Rol</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {usuarios.map((u) => (
            <tr key={u.id}>
              <td>{u.usuario}</td>
              <td>{u.rol}</td>
              <td>
                {u.activo ? "Activo" : "Inactivo"}
                {u.debeCambiarClave && " · clave temporal pendiente"}
              </td>
              <td>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={resetear.isPending && resetear.variables === u.id}
                  onClick={() => {
                    if (confirm(`¿Resetear la clave de "${u.usuario}"? Va a necesitar la clave temporal para volver a entrar.`)) {
                      resetear.mutate(u.id);
                    }
                  }}
                >
                  Resetear clave
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
