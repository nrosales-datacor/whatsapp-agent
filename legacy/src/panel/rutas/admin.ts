import type { IncomingMessage, ServerResponse } from "node:http";
import {
  actualizarConexionWhatsapp,
  actualizarFacturacionTenant,
  actualizarTopeTenant,
  cambiarEstadoTenant,
  crearTenant,
  hayBaseDeDatos,
  listarTenants,
  listarTenantsPausados,
  listarUsuariosDeTenant,
  obtenerTenantPorId,
  obtenerUsuarioPorId,
  recargar,
  resetearClaveUsuario,
} from "../../config/tenantStore";
import { darDeBajaTenant } from "../../config/offboarding";
import {
  actorSuperadmin,
  listarAuditoriaTenant,
  TENANT_PLATAFORMA,
  ultimaPausaPorTenant,
} from "../../config/auditoria";
import { borrarDatosCliente, normalizarTelefono } from "../../config/supresionCliente";
import { limpiarTexto } from "../../config/validadores";
import { dependeDelTokenGlobal, enviarTexto, puedeEnviarWhatsapp } from "../../whatsapp/client";
import { listarJobsEnError, reencolarJobError } from "../../queue/cola";
import { obtenerDb } from "../../db/client";
import {
  configPublica as esConfigPublica,
  embeddedSignupConfigurado,
  guardarTokenTemporal,
  intercambiarCodigo,
  registrarNumero,
  suscribirApp,
  tomarToken,
} from "../../whatsapp/embeddedSignup";
import type { Plan } from "../../types";
import { listarUsoMensualActual } from "../../observabilidad/uso";
import { calcularEstadoCuotasDelMes } from "../../observabilidad/cuotas";
import {
  crearSesionAdmin,
  duracionSesionAdminSeg,
  generarClaveTemporal,
  hashearPassword,
  HASH_DUMMY,
  huellaOrigen,
  totpAdminConfigurado,
  verificarPassword,
} from "../auth";
import { consumirTotp } from "../totp";
import {
  chequearLimiteLogin,
  ipDelRequest,
  registrarExitoLogin,
  registrarFalloLogin,
  registrarIntentoLogin,
} from "../rateLimitLogin";
import { COOKIE_ADMIN, json, json429RateLimit, leerBody } from "../http";
import { sesionDeOperador, esAdmin, tenantParaAdmin } from "../sesion";
import {
  validarAccessToken,
  detalleErrorGraph,
  responderErrorSupresion,
  resumenSupresion,
  validarAltaTenant,
  esChoqueUnico,
  mensajeConflicto,
  auditarPlataforma,
} from "../comun";

// ─────────────────────────────────────────────────────────────────────────────
// API del superadmin (/api/panel/admin/*): login con 2FA, alta/baja/pausa de negocios,
// WhatsApp, reset de claves, supresión de datos, auditoría y DLQ.
// ─────────────────────────────────────────────────────────────────────────────

/** true si manejó la request (rutas admin/*). */
export async function manejarRutasAdmin(req: IncomingMessage, res: ServerResponse, ruta: string, metodo: string): Promise<boolean> {
  // ── Onboarding: API del superadmin (ROADMAP B3). Comparte el guard CSRF de arriba. ──
  if (ruta === "admin/login" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const usuarioInput = String(body?.usuario ?? "");
    const ip = ipDelRequest(req);
    // Rate limit ANTES de scrypt (E6/BLOQUEANTE-10) — ver rateLimitLogin.ts para el
    // porqué (no gastar CPU en una request que igual se va a rechazar).
    const limite = chequearLimiteLogin(ip, "admin", usuarioInput);
    if (!limite.permitido) return json429RateLimit(res, limite.retryAfterSeg), true;
    registrarIntentoLogin(ip);
    const usuarioOk = !!process.env.PANEL_SUPERADMIN_USUARIO && body?.usuario === process.env.PANEL_SUPERADMIN_USUARIO;
    // scrypt SIEMPRE (HASH_DUMMY si falta config/usuario) → no filtra por timing.
    const passOk = await verificarPassword(String(body?.password ?? ""), process.env.PANEL_SUPERADMIN_HASH ?? HASH_DUMMY);
    // Segundo factor (revisión de seguridad 2026-10): si hay PANEL_SUPERADMIN_TOTP_SECRET,
    // el código TOTP es obligatorio. Se chequea SOLO con usuario+clave correctos (así no
    // gasta el anti-replay con intentos ciegos) y el 401 es el mismo en todos los casos:
    // desde afuera no se distingue "clave mala" de "código malo".
    const conTotp = totpAdminConfigurado();
    let totp: "ok" | "invalido" | "reusado" | "no_requerido" = "no_requerido";
    if (usuarioOk && passOk && conTotp) {
      totp = consumirTotp(process.env.PANEL_SUPERADMIN_TOTP_SECRET ?? "", String(body?.codigo ?? ""));
    }
    if (!usuarioOk || !passOk || totp === "invalido" || totp === "reusado") {
      registrarFalloLogin(ip, "admin", usuarioInput);
      if (usuarioOk && passOk) {
        // La clave del superadmin es correcta pero el código no: señal fuerte de que la
        // clave se filtró. Queda en el rastro (sin la IP en claro, ver huellaOrigen).
        await auditarPlataforma(TENANT_PLATAFORMA, "login_admin_rechazado", {
          motivo: totp === "reusado" ? "codigo_reusado" : "codigo_invalido",
          origen: huellaOrigen(ip),
        });
      }
      json(res, 401, { ok: false, error: conTotp ? "Usuario, contraseña o código incorrectos" : "Usuario o contraseña incorrectos" });
      return true;
    }
    registrarExitoLogin(ip, "admin", usuarioInput);
    await auditarPlataforma(TENANT_PLATAFORMA, "login_admin", { totp: totp === "ok", origen: huellaOrigen(ip) });
    const cookie = `${COOKIE_ADMIN}=${crearSesionAdmin(totp === "ok")}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${duracionSesionAdminSeg()}`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (ruta === "admin/logout" && metodo === "POST") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${COOKIE_ADMIN}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (ruta === "admin" || ruta.startsWith("admin/")) {
    if (!esAdmin(req)) {
      json(res, 401, { ok: false, error: "No autenticado" });
      return true;
    }

    if (ruta === "admin/me" && metodo === "GET") {
      json(res, 200, {
        ok: true,
        admin: true,
        usuario: process.env.PANEL_SUPERADMIN_USUARIO ?? "",
        hayDb: hayBaseDeDatos(),
      });
      return true;
    }

    // ── Embedded Signup (ROADMAP C4.2) ──
    // Config pública para que el frontend arme el popup (nunca el app secret).
    if (ruta === "admin/embedded-signup/config" && metodo === "GET") {
      json(res, 200, { ok: true, configurado: embeddedSignupConfigurado(), config: esConfigPublica() });
      return true;
    }

    // Conecta un número: canjea el código del popup por un token, suscribe la app al
    // WABA y registra el número. El token queda en un stash del server; devolvemos un
    // handle opaco que el alta canjea al confirmar (el token NUNCA vuelve al navegador).
    if (ruta === "admin/embedded-signup/conectar" && metodo === "POST") {
      if (!embeddedSignupConfigurado()) {
        return json(res, 503, { ok: false, error: "Embedded Signup no está configurado en este servidor." }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const code = String(body?.code ?? "").trim();
      const phoneNumberId = String(body?.phoneNumberId ?? "").trim();
      const wabaId = String(body?.wabaId ?? "").trim();
      if (!code || code.length > 1024) return json(res, 400, { ok: false, error: "Código de autorización inválido" }), true;
      if (!/^\d{5,30}$/.test(phoneNumberId)) return json(res, 400, { ok: false, error: "phone_number_id inválido" }), true;
      if (!/^\d{5,30}$/.test(wabaId)) return json(res, 400, { ok: false, error: "waba_id inválido" }), true;

      let token: string;
      try {
        token = await intercambiarCodigo(code);
      } catch (e) {
        return json(res, 502, { ok: false, error: e instanceof Error ? e.message : "No se pudo conectar con Meta." }), true;
      }
      // Suscripción de webhooks y registro del número: best-effort (no abortan el alta).
      const suscrito = await suscribirApp(wabaId, token);
      const registrado = await registrarNumero(phoneNumberId, token);
      const tokenHandle = guardarTokenTemporal({ token, phoneNumberId, wabaId });
      return json(res, 200, { ok: true, phoneNumberId, wabaId, tokenHandle, suscrito, registrado }), true;
    }

    if (ruta === "admin/tenants" && metodo === "GET") {
      // Resumen liviano: NUNCA exponemos accessToken por la API.
      // Uso mensual (Carril D, 0.2): una sola consulta para todos los negocios, en vez
      // de N — "medir sin bloquear" (sin DB o sin actividad todavía, queda en 0).
      const uso = await listarUsoMensualActual();
      // Pausados (revisión pre-venta 2026-10): se listan también, marcados, para poder
      // reactivarlos desde acá — antes un negocio con activo=false desaparecía del admin.
      const pausados = listarTenantsPausados();
      let pausas = new Map<string, { desde: string; motivo: string | null }>();
      if (pausados.length && hayBaseDeDatos()) {
        try {
          pausas = await ultimaPausaPorTenant(obtenerDb(), pausados.map((t) => t.id));
        } catch (e) {
          console.error("[admin] ultimaPausaPorTenant:", e); // dato de presentación: no tumba la lista
        }
      }
      const filas = [...listarTenants().map((t) => ({ t, activo: true })), ...pausados.map((t) => ({ t, activo: false }))];
      const tenants = filas.map(({ t, activo }) => {
        const u = uso.get(t.id);
        // Tope mensual de conversaciones (F10): reusa el mismo `uso` ya consultado arriba
        // (una sola query para todos los tenants), sin ir de nuevo a la base por tenant.
        // Tope de gasto de LLM en USD (revisión pre-venta 2026-10): misma fila de uso.
        const { conversaciones: cuota, gastoLlm } = calcularEstadoCuotasDelMes(t, u);
        return {
          id: t.id,
          nombre: t.nombre,
          phoneNumberId: t.phoneNumberId,
          moneda: t.moneda,
          timezone: t.timezone,
          servicios: t.servicios.length,
          plan: t.plan,
          conversacionesEsteMes: u?.conversacionesIniciadas ?? 0,
          // Costo de LLM por tenant (F13): tokens totales (entrada+salida) y costo estimado
          // en USD del mes, para responder "¿este cliente deja margen?" sin ir a la DB a mano.
          // El acumulador guarda millonésimos de dólar (ver schema.ts); acá se divide para
          // mostrar USD directo — la división es solo de PRESENTACIÓN, el contador de la DB
          // sigue siendo el entero exacto.
          tokensEsteMes: (u?.tokensEntrada ?? 0) + (u?.tokensSalida ?? 0),
          costoUsdEsteMes: (u?.costoEstimadoMillonesimos ?? 0) / 1_000_000,
          // Tope mensual (F10): null = sin tope (Pro, o interruptor activado). El
          // superadmin ve acá mismo si un tenant está por pasarse (80%) o ya se pasó
          // (100%, el bot dejó de responder con IA para ese negocio).
          topeConversacionesMes: cuota.tope,
          cuotaPorcentaje: cuota.porcentaje,
          cuotaAlcanzo80: cuota.alcanzo80,
          cuotaExcedida: cuota.excedido,
          topeConversacionesDesactivado: t.topeConversacionesDesactivado ?? false,
          topeGastoLlmUsd: gastoLlm.topeUsd,
          gastoLlmPorcentaje: gastoLlm.porcentaje,
          gastoLlmExcedido: gastoLlm.excedido,
          activo,
          pausadoDesde: activo ? null : (pausas.get(t.id)?.desde ?? null),
          motivoPausa: activo ? null : (pausas.get(t.id)?.motivo ?? null),
          // Estado de la conexión (sin exponer el token): ¿puede enviar? y ¿con el token
          // global del piloto en vez del suyo? — para saber a quién hay que "Reconectar".
          whatsappConectado: puedeEnviarWhatsapp(t),
          whatsappTokenGlobal: dependeDelTokenGlobal(t),
        };
      });
      json(res, 200, { ok: true, tenants });
      return true;
    }

    // Interruptor del tope mensual (F10): excepción de contrato, la cambia el
    // superadmin — mismo patrón que el cambio de plan (admin/tenants/:id/plan).
    const partesTope = ruta.split("/");
    if (partesTope[0] === "admin" && partesTope[1] === "tenants" && partesTope[2] && partesTope[3] === "tope" && metodo === "POST") {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "El cambio de tope requiere base de datos (no configurada)." }), true;
      }
      const tenantId = decodeURIComponent(partesTope[2]);
      if (!tenantParaAdmin(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const desactivado = !!body?.desactivado;
      try {
        await actualizarTopeTenant(tenantId, desactivado);
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "El cambio de tope requiere base de datos." }), true;
        }
        console.error("[admin] actualizarTopeTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo cambiar el tope." }), true;
      }
      await recargar();
      return json(res, 200, { ok: true }), true;
    }

    // Cambio de plan Básico↔Pro desde el admin (Carril D, 0.1): sin redeploy, habilita
    // o quita Campañas/Usuarios/White-label de inmediato (el caché se recarga al final).
    const partesPlan = ruta.split("/");
    if (partesPlan[0] === "admin" && partesPlan[1] === "tenants" && partesPlan[2] && partesPlan[3] === "plan" && metodo === "POST") {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "El cambio de plan requiere base de datos (no configurada)." }), true;
      }
      const tenantId = decodeURIComponent(partesPlan[2]);
      if (!tenantParaAdmin(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const plan: Plan | undefined = body?.plan === "basico" || body?.plan === "pro" ? body.plan : undefined;
      if (!plan) return json(res, 400, { ok: false, error: "plan inválido (\"basico\" o \"pro\")" }), true;
      try {
        await actualizarFacturacionTenant(tenantId, { plan });
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "El cambio de plan requiere base de datos." }), true;
        }
        console.error("[admin] actualizarFacturacionTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo cambiar el plan." }), true;
      }
      await recargar();
      return json(res, 200, { ok: true }), true;
    }

    if (ruta === "admin/tenants" && metodo === "POST") {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "El alta de negocios requiere base de datos (no configurada)." }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      // Alta vía Embedded Signup (C4.2): el token no viaja por el navegador. Llegó un
      // `tokenHandle` que canjeamos por el token (y el phone_number_id verificado)
      // stasheado del lado del server, y lo inyectamos antes de validar.
      if (body && typeof body === "object" && typeof body.tokenHandle === "string" && body.tokenHandle) {
        const conexion = tomarToken(body.tokenHandle);
        if (!conexion) {
          return json(res, 400, { ok: false, error: "La conexión de WhatsApp venció; reconectá el número antes de crear el negocio." }), true;
        }
        body.tenant = { ...(body.tenant ?? {}), accessToken: conexion.token, phoneNumberId: conexion.phoneNumberId };
      }
      const v = validarAltaTenant(body);
      if (!v.ok) return json(res, 400, { ok: false, error: v.error }), true;
      try {
        await crearTenant(v.tenant, { usuario: v.usuario, passwordHash: await hashearPassword(v.password) });
      } catch (e) {
        if (esChoqueUnico(e)) return json(res, 409, { ok: false, error: mensajeConflicto(e) }), true;
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "El alta de negocios requiere base de datos." }), true;
        }
        console.error("[admin] crearTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo crear el negocio." }), true;
      }
      await recargar(); // el negocio queda vivo en el caché sin reiniciar el proceso
      return json(res, 201, { ok: true, tenantId: v.tenant.id }), true;
    }

    // ── Offboarding de tenant + export de datos (ROADMAP F16): borra TODO lo del
    // negocio (conversaciones, mensajes, citas, cotizaciones, etc.) en una sola
    // transacción y devuelve el export completo para que el superadmin se lo lleve
    // antes de que el negocio desaparezca del todo. Exige repetir el nombre EXACTO
    // del tenant como confirmación (ver darDeBajaTenant en config/offboarding.ts).
    const partesBaja = ruta.split("/");
    if (
      partesBaja[0] === "admin" &&
      partesBaja[1] === "tenants" &&
      partesBaja[2] &&
      partesBaja[3] === "baja" &&
      partesBaja.length === 4 &&
      metodo === "POST"
    ) {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "La baja de negocios requiere base de datos (no configurada)." }), true;
      }
      const tenantId = decodeURIComponent(partesBaja[2]);
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const confirmarNombre = typeof body?.confirmarNombre === "string" ? body.confirmarNombre : "";
      if (!confirmarNombre) {
        return json(res, 400, { ok: false, error: "Falta confirmarNombre (nombre exacto del negocio)." }), true;
      }
      let exportado;
      try {
        exportado = await darDeBajaTenant(tenantId, confirmarNombre);
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "La baja de negocios requiere base de datos." }), true;
        }
        if (e instanceof Error && e.message === "TENANT_NO_ENCONTRADO") {
          return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        }
        if (e instanceof Error && e.message === "CONFIRMACION_INVALIDA") {
          return json(res, 400, { ok: false, error: "El nombre no coincide con el del negocio; no se borró nada." }), true;
        }
        console.error("[admin] darDeBajaTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo dar de baja el negocio." }), true;
      }
      await recargar(); // saca al tenant del caché en memoria sin reiniciar el proceso
      return json(res, 200, { ok: true, export: exportado }), true;
    }

    // ── Acciones de plataforma sobre UN negocio (revisión pre-venta 2026-10) ──
    // admin/tenants/:id/{pausar|reactivar|whatsapp|whatsapp/probar|clientes/borrar|auditoria}.
    // Mismo gate que el resto de admin/* (sesión de superadmin) + el CSRF de arriba para
    // los POST + tope de body de leerBody. Todas aceptan negocios activos o pausados.
    const partesAccion = ruta.split("/");
    if (partesAccion[0] === "admin" && partesAccion[1] === "tenants" && partesAccion[2]) {
      const tenantId = decodeURIComponent(partesAccion[2]);
      const accion = partesAccion.slice(3).join("/");

      // Historial auditable del negocio. No exige que exista: el rastro de una baja
      // sigue consultable después de que el negocio desapareció.
      if (accion === "auditoria" && metodo === "GET") {
        if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
        try {
          return json(res, 200, { ok: true, auditoria: await listarAuditoriaTenant(obtenerDb(), tenantId) }), true;
        } catch (e) {
          console.error("[admin] listarAuditoriaTenant:", e);
          return json(res, 500, { ok: false, error: "No se pudo leer el historial." }), true;
        }
      }

      // Pausar / reactivar (cobro manual, PROCESO-COBRO-MANUAL.md §5): reemplaza el UPDATE
      // a mano en Supabase. Motivo opcional, queda en wa_auditoria junto con quién lo hizo.
      if ((accion === "pausar" || accion === "reactivar") && metodo === "POST") {
        if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Pausar negocios requiere base de datos (no configurada)." }), true;
        const body = await leerBody(req);
        if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
        const motivo = limpiarTexto(body?.motivo, 300) || null;
        let r: Awaited<ReturnType<typeof cambiarEstadoTenant>>;
        try {
          r = await cambiarEstadoTenant(tenantId, accion === "reactivar", actorSuperadmin(), motivo);
        } catch (e) {
          if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
          console.error("[admin] cambiarEstadoTenant:", e);
          return json(res, 500, { ok: false, error: "No se pudo cambiar el estado del negocio." }), true;
        }
        if (r === "no_encontrado") return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        if (r === "sin_cambio") {
          return json(res, 409, { ok: false, error: accion === "pausar" ? "El negocio ya estaba pausado." : "El negocio ya estaba activo." }), true;
        }
        await recargar(); // el bot deja de (o vuelve a) responder sin reiniciar
        return json(res, 200, { ok: true }), true;
      }

      // Reconectar WhatsApp: carga o rota phone_number_id + token de un negocio YA creado
      // (antes no había forma: el token está cifrado). Acepta el token pegado a mano o el
      // handle de Embedded Signup (C4.2), igual que el alta — el token nunca vuelve.
      if (accion === "whatsapp" && metodo === "POST") {
        if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
        if (!tenantParaAdmin(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        const body = await leerBody(req);
        if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
        let phoneNumberId = String(body?.phoneNumberId ?? "").trim();
        let tokenCrudo: unknown = body?.accessToken;
        if (typeof body?.tokenHandle === "string" && body.tokenHandle) {
          const conexion = tomarToken(body.tokenHandle);
          if (!conexion) return json(res, 400, { ok: false, error: "La conexión de WhatsApp venció; volvé a conectar el número." }), true;
          phoneNumberId = conexion.phoneNumberId;
          tokenCrudo = conexion.token;
        }
        if (!/^\d{5,30}$/.test(phoneNumberId)) {
          return json(res, 400, { ok: false, error: "El phone_number_id debe ser numérico (5 a 30 dígitos)" }), true;
        }
        const vToken = validarAccessToken(tokenCrudo);
        if (!vToken.ok) return json(res, 400, { ok: false, error: vToken.error }), true;
        try {
          const ok = await actualizarConexionWhatsapp(tenantId, phoneNumberId, vToken.token, actorSuperadmin());
          if (!ok) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        } catch (e) {
          if (esChoqueUnico(e)) return json(res, 409, { ok: false, error: mensajeConflicto(e) }), true;
          if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
          console.error("[admin] actualizarConexionWhatsapp:", e);
          return json(res, 500, { ok: false, error: "No se pudo guardar la conexión de WhatsApp." }), true;
        }
        await recargar(); // el token nuevo se usa desde el próximo mensaje, sin reiniciar
        return json(res, 200, { ok: true, phoneNumberId }), true;
      }

      // Enviar mensaje de prueba con el token/número VIGENTES del negocio. Si Graph falla,
      // se devuelve su mensaje de error tal cual (sin el token) para diagnosticar.
      if (accion === "whatsapp/probar" && metodo === "POST") {
        const t = tenantParaAdmin(tenantId);
        if (!t) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        const body = await leerBody(req);
        if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
        const para = normalizarTelefono(body?.para);
        if (para.length < 8 || para.length > 15) {
          return json(res, 400, { ok: false, error: "Número de destino inválido (con código de país, ej. 50688887777)" }), true;
        }
        const texto = limpiarTexto(body?.texto, 500) || `Mensaje de prueba de Selyon: la conexión de WhatsApp de ${t.nombre} funciona.`;
        try {
          await enviarTexto(t, para, texto);
        } catch (e) {
          return json(res, 502, { ok: false, error: detalleErrorGraph(e) }), true;
        }
        return json(res, 200, { ok: true }), true;
      }

      // Borrar un cliente final (derecho de supresión, Ley 8968) desde el admin: por
      // teléfono, porque el superadmin no ve las conversaciones del negocio.
      if (accion === "clientes/borrar" && metodo === "POST") {
        const t = tenantParaAdmin(tenantId);
        if (!t) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
        const body = await leerBody(req);
        if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
        const clienteWa = normalizarTelefono(body?.clienteWa);
        if (!clienteWa) return json(res, 400, { ok: false, error: "Falta el teléfono del cliente" }), true;
        if (normalizarTelefono(body?.confirmar) !== clienteWa) {
          return json(res, 400, { ok: false, error: "La confirmación no coincide con el teléfono; no se borró nada." }), true;
        }
        try {
          const r = await borrarDatosCliente({ tenant: t, clienteWa, actor: actorSuperadmin() });
          return json(res, 200, { ok: true, ...resumenSupresion(r) }), true;
        } catch (e) {
          return responderErrorSupresion(res, e), true;
        }
      }
    }

    // ── DLQ visible (ROADMAP F11): jobs de wa_jobs que agotaron reintentos ──
    // (estado='error'), agrupados por tenant. Antes de esto no había forma de
    // ver cuántos mensajes de qué negocio quedaron sin responder.
    if (ruta === "admin/dlq" && metodo === "GET") {
      if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "El DLQ requiere base de datos (no configurada)." }), true;
      let jobs;
      try {
        jobs = await listarJobsEnError(obtenerDb());
      } catch (e) {
        console.error("[admin] listarJobsEnError:", e);
        return json(res, 500, { ok: false, error: "No se pudo leer el DLQ." }), true;
      }
      // Agrupado por tenant (listarJobsEnError ya ordena por tenantId, así que alcanza
      // con ir acumulando en orden): el nombre del negocio viene del caché de tenants
      // (tenantStore), no de un JOIN — evita depender de que el tenant siga existiendo.
      const porTenant = new Map<string, { tenantId: string; nombre: string; jobs: typeof jobs }>();
      for (const j of jobs) {
        let grupo = porTenant.get(j.tenantId);
        if (!grupo) {
          grupo = { tenantId: j.tenantId, nombre: obtenerTenantPorId(j.tenantId)?.nombre ?? "(negocio dado de baja)", jobs: [] };
          porTenant.set(j.tenantId, grupo);
        }
        grupo.jobs.push(j);
      }
      const tenants = [...porTenant.values()].map((g) => ({
        tenantId: g.tenantId,
        nombre: g.nombre,
        cantidad: g.jobs.length,
        jobs: g.jobs.map((j) => ({
          id: j.id,
          intentos: j.intentos,
          maxIntentos: j.maxIntentos,
          ultimoError: j.ultimoError,
          creadoEn: j.creadoEn.toISOString(),
          finalizadoEn: j.finalizadoEn ? j.finalizadoEn.toISOString() : null,
          extractoMensaje: j.extractoMensaje,
        })),
      }));
      return json(res, 200, { ok: true, tenants }), true;
    }

    // Reencolar un job del DLQ (ROADMAP F11): lo vuelve "pendiente" para que el
    // worker lo tome de nuevo. Protegido en la propia query (reencolarJobError
    // solo toca estado='error'): reencolar algo que no está en error es un
    // no-op que devuelve false, no un 500.
    const partesDlqReencolar = ruta.split("/");
    if (
      partesDlqReencolar[0] === "admin" &&
      partesDlqReencolar[1] === "dlq" &&
      partesDlqReencolar[2] &&
      partesDlqReencolar[3] === "reencolar" &&
      metodo === "POST"
    ) {
      if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "El DLQ requiere base de datos (no configurada)." }), true;
      const jobId = decodeURIComponent(partesDlqReencolar[2]);
      let reencolado: boolean;
      try {
        reencolado = await reencolarJobError(obtenerDb(), jobId);
      } catch (e) {
        console.error("[admin] reencolarJobError:", e);
        return json(res, 500, { ok: false, error: "No se pudo reencolar el job." }), true;
      }
      if (!reencolado) {
        return json(res, 409, { ok: false, error: "El job no existe o no está en estado 'error'." }), true;
      }
      return json(res, 200, { ok: true }), true;
    }

    // Equipo de un negocio, visto desde el admin (Carril D, 0.5): para elegir a quién
    // resetearle la clave. Reusa listarUsuariosDeTenant (mismo dato que ve el dueño).
    const partesUsuariosTenant = ruta.split("/");
    if (
      partesUsuariosTenant[0] === "admin" &&
      partesUsuariosTenant[1] === "tenants" &&
      partesUsuariosTenant[2] &&
      partesUsuariosTenant[3] === "usuarios" &&
      metodo === "GET"
    ) {
      if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
      const tenantId = decodeURIComponent(partesUsuariosTenant[2]);
      if (!tenantParaAdmin(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
      const usuarios = await listarUsuariosDeTenant(tenantId);
      return json(res, 200, { ok: true, usuarios }), true;
    }

    // Reset de contraseña desde el admin (Carril D, 0.5): clave temporal de un solo uso,
    // vence en 24h; el panel fuerza el cambio al primer login (debeCambiarClave).
    const partesResetClave = ruta.split("/");
    if (
      partesResetClave[0] === "admin" &&
      partesResetClave[1] === "usuarios" &&
      partesResetClave[2] &&
      partesResetClave[3] === "reset-password" &&
      metodo === "POST"
    ) {
      if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
      const usuarioId = decodeURIComponent(partesResetClave[2]);
      const claveTemporal = generarClaveTemporal();
      const expiraEn = new Date(Date.now() + 24 * 60 * 60 * 1000);
      let usuario;
      try {
        usuario = await resetearClaveUsuario(usuarioId, await hashearPassword(claveTemporal), expiraEn);
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
        console.error("[admin] resetearClaveUsuario:", e);
        return json(res, 500, { ok: false, error: "No se pudo resetear la clave." }), true;
      }
      if (!usuario) return json(res, 404, { ok: false, error: "Usuario no encontrado" }), true;
      // Rastro del reset (revisión de seguridad 2026-10): a qué cuenta y de qué negocio.
      const cuentaReseteada = obtenerUsuarioPorId(usuarioId);
      await auditarPlataforma(cuentaReseteada?.tenantId ?? TENANT_PLATAFORMA, "reset_clave", { usuarioId });
      // E13/ALTO-06: sin este recargar(), el caché seguiría sirviendo el sessionEpoch
      // (y el passwordHash) viejos hasta el refresco periódico — la sesión que se está
      // revocando con este reset seguiría pasando sesionDeOperador mientras tanto.
      await recargar();
      return json(res, 200, { ok: true, usuario: usuario.usuario, claveTemporal, expiraEn: expiraEn.toISOString() }), true;
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;
  }
  return false;
}
