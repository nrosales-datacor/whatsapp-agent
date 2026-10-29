import type { IncomingMessage, ServerResponse } from "node:http";
import { obtenerTenantPausadoPorId, obtenerTenantPorId, obtenerUsuario } from "../../config/tenantStore";
import type { Repositorio } from "../../types";
import { crearSesion, HASH_DUMMY, verificarPassword } from "../auth";
import { clavePublicaVapid } from "../push";
import {
  chequearLimiteLogin,
  ipDelRequest,
  registrarExitoLogin,
  registrarFalloLogin,
  registrarIntentoLogin,
} from "../rateLimitLogin";
import { COOKIE, json, json429RateLimit, leerBody } from "../http";
import { sesionDeOperador, jsonCuentaPausada } from "../sesion";

// ─────────────────────────────────────────────────────────────────────────────
// Login y logout del operador (antes del guard de sesión).
// ─────────────────────────────────────────────────────────────────────────────

export async function manejarRutasAcceso(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repositorio,
  ruta: string,
  metodo: string,
): Promise<boolean> {
  // ── Login ──
  if (ruta === "login" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const { usuario, password } = body;
    const usuarioInput = String(usuario ?? "");
    const ip = ipDelRequest(req);
    // Rate limit ANTES de scrypt (E6/BLOQUEANTE-10): si ya sabemos que la request se va
    // a rechazar, no gastamos los ~50-150ms de CPU de scrypt en ella. La clave "por
    // usuario" es el string crudo (exista o no la cuenta) — ver rateLimitLogin.ts para
    // el porqué: así el 429 no se convierte en un oráculo de qué usuarios existen.
    const limite = chequearLimiteLogin(ip, "login", usuarioInput);
    if (!limite.permitido) return json429RateLimit(res, limite.retryAfterSeg), true;
    registrarIntentoLogin(ip);
    // Resuelve usuario → cuenta (wa_usuarios) → tenant, vía el caché del tenantStore.
    const cuenta = obtenerUsuario(usuarioInput);
    // Corremos scrypt SIEMPRE (con un hash dummy si el usuario no existe) para no
    // filtrar por timing qué usuarios son válidos. El 401 es idéntico en ambos casos.
    const ok = await verificarPassword(String(password ?? ""), cuenta?.passwordHash ?? HASH_DUMMY);
    const tenant = cuenta ? obtenerTenantPorId(cuenta.tenantId) : undefined;
    // Clave temporal del reset de admin (0.5): vencida a las 24h, hay que pedir un reset nuevo.
    const claveVencida = !!cuenta?.claveTemporalExpira && Date.now() > cuenta.claveTemporalExpira.getTime();
    // Negocio pausado por la plataforma: con la clave CORRECTA se le explica por qué no
    // entra (en vez del "usuario o contraseña incorrectos" de antes). Sin la clave correcta
    // sigue el 401 genérico de abajo — no es un oráculo de qué negocios están pausados.
    if (cuenta && ok && !tenant && !claveVencida && obtenerTenantPausadoPorId(cuenta.tenantId)) {
      registrarExitoLogin(ip, "login", usuarioInput);
      return jsonCuentaPausada(res), true;
    }
    if (!cuenta || !ok || !tenant || claveVencida) {
      registrarFalloLogin(ip, "login", usuarioInput);
      const error = claveVencida
        ? "La clave temporal venció. Pedile a tu administrador que te la resetee de nuevo."
        : "Usuario o contraseña incorrectos";
      json(res, 401, { ok: false, error });
      return true;
    }
    registrarExitoLogin(ip, "login", usuarioInput);
    // El login NO sube el epoch (E13/ALTO-06): firma con el epoch VIGENTE de la cuenta,
    // así que loguearse desde un dispositivo nuevo no invalida las sesiones ya abiertas
    // en otros dispositivos — solo cambiar clave/rol/estado revoca sesiones.
    const cookie = `${COOKIE}=${crearSesion(tenant.id, cuenta.id, cuenta.rol, cuenta.sessionEpoch)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie });
    res.end(JSON.stringify({ ok: true, nombre: tenant.nombre, vapidPublica: clavePublicaVapid() }));
    return true;
  }

  if (ruta === "logout" && metodo === "POST") {
    // Notificaciones push del dispositivo que cierra sesión (revisión de seguridad 2026-10):
    // el panel manda el `endpoint` de ESTE navegador y se borra esa suscripción — un
    // teléfono o tablet compartido deja de recibir los mensajes de los clientes al salir.
    // Solo se borra si la sesión es válida y la suscripción es de ese mismo usuario.
    const sesionSaliente = sesionDeOperador(req);
    const body = await leerBody(req);
    if (sesionSaliente && body && typeof body.endpoint === "string" && body.endpoint) {
      await repo
        .borrarPushSub(sesionSaliente.tenant.id, body.endpoint.slice(0, 2048), sesionSaliente.usuarioId)
        .catch((e) => console.error("[push] borrar suscripción en logout:", e));
    }
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}
