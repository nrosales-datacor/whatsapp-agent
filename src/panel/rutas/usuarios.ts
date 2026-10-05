import {
  actualizarUsuarioTenant,
  crearUsuarioTenant,
  hayBaseDeDatos,
  listarUsuariosDeTenant,
  recargar,
} from "../../config/tenantStore";
import type { Rol } from "../../types";
import { tenantPuede } from "../../billing/planes";
import { hashearPassword } from "../auth";
import { json, leerBody } from "../http";
import { RE_USUARIO, esChoqueUnico, demasiadosChoquesDeUsuario, registrarChoqueDeUsuario } from "../comun";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Usuarios del panel del negocio (C2.3): solo el dueño.
// ─────────────────────────────────────────────────────────────────────────────

/** usuarios y usuarios/:id. */
export async function manejarRutasUsuarios(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, ruta, metodo, tenant, rol, usuarioId } = ctx;
  // ── Usuarios del panel del negocio (ROADMAP C2.3) — solo dueño ──
  if (ruta === "usuarios" || ruta.startsWith("usuarios/")) {
    if (rol !== "dueno") {
      json(res, 403, { ok: false, error: "Solo el dueño del negocio puede gestionar usuarios" });
      return true;
    }
    if (!tenantPuede(tenant, "multiUsuario")) {
      json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" });
      return true;
    }
    // A diferencia de "config" (que lee del tenant ya cacheado), esto consulta la base
    // directo: sin DATABASE_URL (dev local sin DB) no hay dónde leer/escribir usuarios.
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "La gestión de usuarios requiere base de datos (no configurada)." }), true;
    }

    if (ruta === "usuarios" && metodo === "GET") {
      const usuarios = await listarUsuariosDeTenant(tenant.id);
      return json(res, 200, { ok: true, usuarios }), true;
    }

    if (ruta === "usuarios" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const usuario = String(body?.usuario ?? "").trim();
      if (!RE_USUARIO.test(usuario)) {
        return json(res, 400, { ok: false, error: "Usuario inválido (3 a 40 caracteres: letras, números, . _ -)" }), true;
      }
      const password = String(body?.password ?? "");
      if (password.length < 8) return json(res, 400, { ok: false, error: "La contraseña debe tener al menos 8 caracteres" }), true;
      if (demasiadosChoquesDeUsuario(tenant.id)) {
        return json(res, 429, { ok: false, error: "Demasiados intentos con usuarios que ya existen. Probá de nuevo más tarde." }), true;
      }
      // El usuario del superadmin responde IGUAL que uno que ya existe: antes decía "está
      // reservado" y así cualquier dueño podía descubrir el usuario del superadmin probando.
      if (usuario === process.env.PANEL_SUPERADMIN_USUARIO) {
        registrarChoqueDeUsuario(tenant.id);
        return json(res, 409, { ok: false, error: "Ese usuario de panel ya existe" }), true;
      }
      const nuevoRol: Rol = body?.rol === "dueno" ? "dueno" : "operador";
      try {
        await crearUsuarioTenant(tenant.id, { usuario, passwordHash: await hashearPassword(password), rol: nuevoRol });
      } catch (e) {
        if (esChoqueUnico(e)) {
          registrarChoqueDeUsuario(tenant.id);
          return json(res, 409, { ok: false, error: "Ese usuario de panel ya existe" }), true;
        }
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "La gestión de usuarios requiere base de datos." }), true;
        }
        console.error("[usuarios] crearUsuarioTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo crear el usuario." }), true;
      }
      await recargar();
      return json(res, 201, { ok: true }), true;
    }

    // /usuarios/{id}: actualizar rol/activo
    const partesUsuario = ruta.split("/");
    if (partesUsuario[0] === "usuarios" && partesUsuario[1] && metodo === "POST") {
      const usuarioId = decodeURIComponent(partesUsuario[1]);
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;

      const patch: { rol?: Rol; activo?: boolean } = {};
      if (body?.rol !== undefined) {
        if (body.rol !== "dueno" && body.rol !== "operador") return json(res, 400, { ok: false, error: "rol inválido" }), true;
        patch.rol = body.rol;
      }
      if (body?.activo !== undefined) {
        if (typeof body.activo !== "boolean") return json(res, 400, { ok: false, error: "activo inválido" }), true;
        patch.activo = body.activo;
      }
      if (patch.rol === undefined && patch.activo === undefined) {
        return json(res, 400, { ok: false, error: "Nada para actualizar" }), true;
      }

      // Guard: siempre debe quedar al menos un dueño activo (si no, el negocio queda
      // sin nadie que pueda gestionar usuarios ni "Mi negocio").
      const dejariaSinDueno =
        (patch.rol === "operador" || patch.activo === false) &&
        (await (async () => {
          const equipo = await listarUsuariosDeTenant(tenant.id);
          const otrosDuenosActivos = equipo.filter((u) => u.id !== usuarioId && u.rol === "dueno" && u.activo);
          return otrosDuenosActivos.length === 0;
        })());
      if (dejariaSinDueno) {
        return json(res, 400, { ok: false, error: "Debe quedar al menos un dueño activo" }), true;
      }

      try {
        await actualizarUsuarioTenant(tenant.id, usuarioId, patch);
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "La gestión de usuarios requiere base de datos." }), true;
        }
        console.error("[usuarios] actualizarUsuarioTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo actualizar el usuario." }), true;
      }
      await recargar();
      return json(res, 200, { ok: true }), true;
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;
  }
  return false;
}
