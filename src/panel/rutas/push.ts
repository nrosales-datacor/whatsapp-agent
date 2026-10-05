import { obtenerUsuarioPorId } from "../../config/tenantStore";
import { enviarPushATenant, MAX_PUSH_SUBS_POR_USUARIO, validarSuscripcionPush } from "../push";
import { json, leerBody } from "../http";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones push del panel (suscribir, desuscribir, probar).
// ─────────────────────────────────────────────────────────────────────────────

/** push/*. */
export async function manejarRutasPush(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, repo, ruta, metodo, tenant, rol, usuarioId } = ctx;
  // ── Notificaciones push ──
  // Revisión de seguridad 2026-10: la suscripción es del USUARIO (no solo del negocio) y
  // lleva su sessionEpoch — desactivarlo, cambiarle la clave/rol o hacer logout corta sus
  // notificaciones. El endpoint se valida contra la allowlist de servicios de push reales
  // (https), porque es una URL a la que el servidor le hace POST (antes: SSRF ciego).
  if (ruta === "push/suscribir" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const v = validarSuscripcionPush(body);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error }), true;
    const cuenta = obtenerUsuarioPorId(usuarioId);
    if (!cuenta) return json(res, 401, { ok: false, error: "No autenticado" }), true;
    await repo.guardarPushSub(
      tenant.id,
      { ...v.sub, usuarioId, sessionEpoch: cuenta.sessionEpoch },
      { maxPorUsuario: MAX_PUSH_SUBS_POR_USUARIO },
    );
    return json(res, 200, { ok: true }), true;
  }

  if (ruta === "push/desuscribir" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    if (typeof body?.endpoint === "string" && body.endpoint) {
      await repo.borrarPushSub(tenant.id, body.endpoint.slice(0, 2048), usuarioId);
    }
    return json(res, 200, { ok: true }), true;
  }

  if (ruta === "push/probar" && metodo === "POST") {
    // Solo a los dispositivos de quien la pide (antes: a todo el equipo del negocio).
    const r = await enviarPushATenant(
      repo,
      tenant.id,
      {
        title: "✅ Notificaciones activas",
        body: "Te avisaremos por acá cuando un cliente necesite atención.",
        url: "/panel/",
        tag: "prueba",
      },
      { soloUsuarioId: usuarioId },
    );
    return json(res, 200, { ok: true, ...r }), true;
  }
  return false;
}
