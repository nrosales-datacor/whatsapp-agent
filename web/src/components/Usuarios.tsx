import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { actualizarUsuario, crearUsuario, listarUsuarios, type Rol } from "../api";
import ErrorState from "./ErrorState";
import EstadoVacio from "./EstadoVacio";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Usuarios" (ROADMAP C2.3): solo el dueño la ve (Panel.tsx la esconde para
// operadores; el backend también rechaza /api/panel/usuarios si el rol no es
// "dueno" — la pestaña escondida no es el único guard). Mismo patrón de
// tarjetas + toasts que "Mi negocio" (MiNegocio.tsx).
// ─────────────────────────────────────────────────────────────────────────────

const RE_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;

interface Props {
  /** Id del usuario logueado — evita que se degrade/desactive a sí mismo (auto-lockout). */
  usuarioActualId: string;
}

export default function Usuarios({ usuarioActualId }: Props) {
  const qc = useQueryClient();
  const { flash } = useToast();
  const q = useQuery({ queryKey: ["usuarios"], queryFn: listarUsuarios });

  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [rol, setRol] = useState<Rol>("operador");

  const invalidar = () => qc.invalidateQueries({ queryKey: ["usuarios"] });

  const crear = useMutation({
    mutationFn: () => crearUsuario(usuario.trim(), password, rol),
    onSuccess: () => {
      invalidar();
      setUsuario("");
      setPassword("");
      setRol("operador");
      flash("Usuario creado");
    },
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo crear el usuario"),
  });

  const actualizar = useMutation({
    mutationFn: (args: { id: string; patch: { rol?: Rol; activo?: boolean } }) => actualizarUsuario(args.id, args.patch),
    onSuccess: invalidar,
    onError: (e) => flash(e instanceof Error ? e.message : "No se pudo actualizar el usuario"),
  });

  function alCrear() {
    if (!RE_USUARIO.test(usuario.trim())) {
      flash("Usuario inválido (3 a 40 caracteres: letras, números, . _ -)");
      return;
    }
    if (password.length < 8) {
      flash("La contraseña debe tener al menos 8 caracteres");
      return;
    }
    crear.mutate();
  }

  const usuarios = q.data ?? [];

  if (q.isLoading) {
    return (
      <div id="usuarios">
        <div className="dash-body">
          <p className="dash-vacio">Cargando…</p>
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div id="usuarios">
        <div className="dash-body">
          <ErrorState mensaje="No se pudieron cargar los usuarios." onReintentar={() => q.refetch()} />
        </div>
      </div>
    );
  }

  return (
    <div id="usuarios">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Usuarios</h2>
        </div>

        <div className="card">
          <h3>Equipo ({usuarios.length})</h3>
          {usuarios.length === 0 ? (
            <EstadoVacio icono="user" titulo="Todavía no hay usuarios" ayuda="Los que agregues con el formulario de abajo van a aparecer acá." />
          ) : (
            <div className="admin-tabla-scroll">
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
                  {usuarios.map((u) => {
                    const esYo = u.id === usuarioActualId;
                    // Fila pendiente: solo deshabilita ESTA fila mientras la mutación corre
                    // (antes cualquier acción bloqueaba los controles de toda la tabla).
                    const filaPendiente = actualizar.isPending && actualizar.variables?.id === u.id;
                    return (
                      <tr key={u.id}>
                        <td>{u.usuario}{esYo && " (vos)"}</td>
                        <td>
                          <select
                            value={u.rol}
                            title="Rol del usuario"
                            disabled={filaPendiente || esYo}
                            onChange={(e) => {
                              const nuevoRol = e.target.value as Rol;
                              if (!window.confirm(`¿Cambiar el rol de "${u.usuario}" a ${nuevoRol === "dueno" ? "Dueño" : "Operador"}?`)) return;
                              actualizar.mutate({ id: u.id, patch: { rol: nuevoRol } });
                            }}
                          >
                            <option value="dueno">Dueño</option>
                            <option value="operador">Operador</option>
                          </select>
                        </td>
                        <td>{u.activo ? "Activo" : "Inactivo"}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={filaPendiente || esYo}
                            title={esYo ? "No podés desactivarte a vos mismo" : undefined}
                            onClick={() => {
                              const mensaje = u.activo
                                ? `¿Desactivar a "${u.usuario}"? No podrá volver a iniciar sesión.`
                                : `¿Reactivar a "${u.usuario}"?`;
                              if (!window.confirm(mensaje)) return;
                              actualizar.mutate({ id: u.id, patch: { activo: !u.activo } });
                            }}
                          >
                            {u.activo ? "Desactivar" : "Reactivar"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card admin-form">
          <h3>Agregar usuario</h3>
          <div className="admin-servicio">
            <input placeholder="usuario" value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="off" />
            <input
              placeholder="contraseña"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <select value={rol} title="Rol del nuevo usuario" onChange={(e) => setRol(e.target.value as Rol)}>
              <option value="operador">Operador</option>
              <option value="dueno">Dueño</option>
            </select>
          </div>
          <button type="button" className="accion accion-primaria" disabled={crear.isPending} onClick={alCrear}>
            {crear.isPending ? "Creando…" : "+ Agregar usuario"}
          </button>
        </div>
      </div>
    </div>
  );
}
