import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { actualizarUsuario, crearUsuario, listarUsuarios, type Rol, type UsuarioTenant } from "../api";
import ErrorState from "./ErrorState";
import EstadoVacio from "./EstadoVacio";
import Icono from "./Iconos";
import { iniciales } from "../lib/formato";
import { useToast } from "./Toast";

// ─────────────────────────────────────────────────────────────────────────────
// "Usuarios" (ROADMAP C2.3): solo el dueño la ve (Panel.tsx la esconde para
// operadores; el backend también rechaza /api/panel/usuarios si el rol no es
// "dueno" — la pestaña escondida no es el único guard). Mismo patrón de
// tarjetas + toasts que "Mi negocio" (MiNegocio.tsx).
//
// Rediseño visual (design_handoff_panel_whatsapp/, pantalla 8): avatar con
// iniciales (el dueño en acento sólido, el resto en acento suave), estado como
// chip con punto (no texto suelto), tabla en desktop / tarjetas en móvil.
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
  const [mostrarPassword, setMostrarPassword] = useState(false);
  const [rol, setRol] = useState<Rol>("operador");

  const invalidar = () => qc.invalidateQueries({ queryKey: ["usuarios"] });

  const crear = useMutation({
    mutationFn: () => crearUsuario(usuario.trim(), password, rol),
    onSuccess: () => {
      invalidar();
      setUsuario("");
      setPassword("");
      setMostrarPassword(false);
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

  function filaPendiente(u: UsuarioTenant) {
    // Solo deshabilita ESTA fila mientras la mutación corre (antes cualquier
    // acción bloqueaba los controles de toda la tabla).
    return actualizar.isPending && actualizar.variables?.id === u.id;
  }

  function renderRolSelect(u: UsuarioTenant, esYo: boolean) {
    return (
      <select
        value={u.rol}
        title="Rol del usuario"
        disabled={filaPendiente(u) || esYo}
        onChange={(e) => {
          const nuevoRol = e.target.value as Rol;
          if (!window.confirm(`¿Cambiar el rol de "${u.usuario}" a ${nuevoRol === "dueno" ? "Dueño" : "Operador"}?`)) return;
          actualizar.mutate({ id: u.id, patch: { rol: nuevoRol } });
        }}
      >
        <option value="dueno">Dueño</option>
        <option value="operador">Operador</option>
      </select>
    );
  }

  function renderAccionBtn(u: UsuarioTenant, esYo: boolean) {
    return (
      <button
        type="button"
        className="btn-ghost"
        disabled={filaPendiente(u) || esYo}
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
    );
  }

  function renderEstadoChip(u: UsuarioTenant) {
    return (
      <span className={"us-estado-chip" + (u.activo ? " us-estado-activo" : "")}>
        <span className="us-estado-dot" />
        {u.activo ? "Activo" : "Inactivo"}
      </span>
    );
  }

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
      <div className="dash-body us-content">
        <div className="dash-titulo">
          <h2>Usuarios</h2>
          <p>Quién entra al panel y con qué permisos.</p>
        </div>

        <div className="card">
          <div className="us-equipo-header">
            <h3>Equipo</h3>
            <span className="us-chip-count">{usuarios.length}</span>
          </div>
          {usuarios.length === 0 ? (
            <EstadoVacio icono="user" titulo="Todavía no hay usuarios" ayuda="Los que agregues con el formulario de abajo van a aparecer acá." />
          ) : (
            <>
              <div className="admin-tabla-scroll us-tabla-desktop">
                <table className="admin-tabla">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Rol</th>
                      <th>Estado</th>
                      <th className="us-acciones-col">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usuarios.map((u) => {
                      const esYo = u.id === usuarioActualId;
                      return (
                        <tr key={u.id}>
                          <td>
                            <div className="us-usuario-cell">
                              <span className={"us-avatar" + (u.rol === "dueno" ? " us-avatar-dueno" : "")}>
                                {iniciales(u.usuario)}
                              </span>
                              <span className="us-nombre">
                                {u.usuario}
                                {esYo && <span className="us-vos"> (vos)</span>}
                              </span>
                            </div>
                          </td>
                          <td>{renderRolSelect(u, esYo)}</td>
                          <td>{renderEstadoChip(u)}</td>
                          <td className="us-acciones-col">{renderAccionBtn(u, esYo)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="us-lista-movil">
                {usuarios.map((u) => {
                  const esYo = u.id === usuarioActualId;
                  return (
                    <div className="us-card-movil" key={u.id}>
                      <div className="us-usuario-cell">
                        <span className={"us-avatar" + (u.rol === "dueno" ? " us-avatar-dueno" : "")}>
                          {iniciales(u.usuario)}
                        </span>
                        <div className="us-card-movil-info">
                          <div className="us-nombre">
                            {u.usuario}
                            {esYo && <span className="us-vos"> (vos)</span>}
                          </div>
                          <div className="us-card-movil-rol">{u.rol === "dueno" ? "Dueño" : "Operador"}</div>
                        </div>
                        {renderEstadoChip(u)}
                      </div>
                      <div className="us-card-movil-footer">
                        {renderRolSelect(u, esYo)}
                        {renderAccionBtn(u, esYo)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="card admin-form">
          <h3>Agregar usuario</h3>
          <div className="us-form-grid">
            <div className="campo">
              <label htmlFor="uNuevoUsuario">Usuario</label>
              <input
                id="uNuevoUsuario"
                placeholder="usuario"
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="campo">
              <label htmlFor="uNuevaPass">Contraseña</label>
              <div className="login-pass-wrap">
                <input
                  id="uNuevaPass"
                  placeholder="contraseña"
                  type={mostrarPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="login-pass-toggle"
                  onClick={() => setMostrarPassword((v) => !v)}
                  title={mostrarPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  aria-label={mostrarPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  <Icono id={mostrarPassword ? "eyeoff" : "eye"} size={18} />
                </button>
              </div>
            </div>
            <div className="campo">
              <label htmlFor="uNuevoRol">Rol</label>
              <select id="uNuevoRol" value={rol} title="Rol del nuevo usuario" onChange={(e) => setRol(e.target.value as Rol)}>
                <option value="operador">Operador</option>
                <option value="dueno">Dueño</option>
              </select>
            </div>
          </div>
          <p className="campo-ayuda">El Operador ve bandeja y agenda; el Dueño configura todo.</p>
          <button type="button" className="accion accion-primaria" disabled={crear.isPending} onClick={alCrear}>
            <Icono id="userplus" size={16} />
            {crear.isPending ? "Creando…" : "Agregar usuario"}
          </button>
        </div>
      </div>
    </div>
  );
}
