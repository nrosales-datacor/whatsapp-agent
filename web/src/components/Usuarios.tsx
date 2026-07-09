import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { actualizarUsuario, crearUsuario, listarUsuarios, type Rol } from "../api";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Usuarios" (ROADMAP C2.3): solo el dueño la ve (Panel.tsx la esconde para
// operadores; el backend también rechaza /api/panel/usuarios si el rol no es
// "dueno" — la pestaña escondida no es el único guard). Mismo patrón de
// tarjetas + toasts que "Mi negocio" (MiNegocio.tsx).
// ─────────────────────────────────────────────────────────────────────────────

const RE_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;

export default function Usuarios() {
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
          <p className="dash-vacio">No se pudieron cargar los usuarios.</p>
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
            <div className="admin-vacio">Todavía no hay usuarios.</div>
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
                  {usuarios.map((u) => (
                    <tr key={u.id}>
                      <td>{u.usuario}</td>
                      <td>
                        <select
                          value={u.rol}
                          disabled={actualizar.isPending}
                          onChange={(e) => actualizar.mutate({ id: u.id, patch: { rol: e.target.value as Rol } })}
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
                          disabled={actualizar.isPending}
                          onClick={() => actualizar.mutate({ id: u.id, patch: { activo: !u.activo } })}
                        >
                          {u.activo ? "Desactivar" : "Reactivar"}
                        </button>
                      </td>
                    </tr>
                  ))}
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
            <select value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
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
