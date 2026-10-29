import type { ServerResponse } from "node:http";
import { hayBaseDeDatos } from "../config/tenantStore";
import { actorSuperadmin, registrarAuditoria, type AccionAuditoria } from "../config/auditoria";
import { borrarDatosCliente, type ResultadoSupresion } from "../config/supresionCliente";
import {
  limpiarLineas,
  limpiarTexto,
  validarFaq,
  validarHorario,
  validarRegistro,
  validarSecciones,
  validarServicios,
  validarTamanoKb,
} from "../config/validadores";
import { obtenerDb } from "../db/client";
import type { KnowledgeBase, SegmentoFiltro, Tenant } from "../types";
import { json } from "./http";

// ─────────────────────────────────────────────────────────────────────────────
// Validaciones y helpers compartidos por varias rutas del panel (alta de negocios,
// usuarios, campañas, supresión de datos, auditoría de plataforma).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token de WhatsApp (alta y "Reconectar WhatsApp"): OBLIGATORIO. Antes era opcional con
 * el texto "vacío usa el número de prueba", pero desde F5 (ALTO-05) `tokenDeTenant`
 * falla sin token propio — el negocio quedaba creado y mudo, y como el token se guarda
 * cifrado (F2) no había forma de cargarlo después ni siquiera por SQL.
 */
export function validarAccessToken(v: unknown): { ok: true; token: string } | { ok: false; error: string } {
  const token = typeof v === "string" ? v.trim() : "";
  if (!token) return { ok: false, error: "El access token de WhatsApp es obligatorio" };
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) {
    return { ok: false, error: "El access token de WhatsApp no tiene un formato válido (20 a 512 caracteres, sin espacios)" };
  }
  return { ok: true, token };
}

/** Extrae el mensaje legible de un error de Graph ("Error enviando WhatsApp (400): {json}")
 * para mostrárselo al superadmin en "Enviar mensaje de prueba". Nunca incluye el token
 * (Graph no lo devuelve en el cuerpo del error). */
export function detalleErrorGraph(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const i = msg.indexOf("{");
  if (i >= 0) {
    try {
      const err = JSON.parse(msg.slice(i))?.error;
      if (err?.message) {
        const codigo = err.code ? ` (código ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ""})` : "";
        return `${String(err.message).slice(0, 300)}${codigo}`;
      }
    } catch {
      // no era JSON: se devuelve el mensaje crudo recortado
    }
  }
  return msg.slice(0, 300);
}

/** Mapea los errores de `borrarDatosCliente` a la respuesta HTTP. */
export function responderErrorSupresion(res: ServerResponse, e: unknown): void {
  const m = e instanceof Error ? e.message : "";
  if (m === "SIN_DB") return json(res, 503, { ok: false, error: "Borrar datos de clientes requiere base de datos." });
  if (m === "CLIENTE_NO_ENCONTRADO") return json(res, 404, { ok: false, error: "No hay datos de ese cliente en este negocio." });
  if (m === "CALENDARIO_FALLO") {
    return json(res, 502, { ok: false, error: "No se pudieron borrar los eventos de Google Calendar; no se borró nada. Probá de nuevo." });
  }
  if (m === "STORAGE_FALLO") {
    return json(res, 502, { ok: false, error: "No se pudieron borrar las fotos guardadas; no se borró nada. Probá de nuevo." });
  }
  console.error("[supresion] borrarDatosCliente:", e);
  json(res, 500, { ok: false, error: "No se pudieron borrar los datos del cliente." });
}

/** Respuesta de un borrado exitoso: solo conteos (nada del cliente). */
export function resumenSupresion(r: ResultadoSupresion) {
  return { conteos: r.conteos, archivosStorage: r.archivosStorage, eventosCalendario: r.eventosCalendario };
}

// ── Validación del alta de negocios (server-side; no confiar en el cliente) ──
// Los validadores de horario/servicios/faq/bloqueos viven en ../config/validadores,
// compartidos con la config self-service (ROADMAP C2.2).
export const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RE_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;

export type ResultadoAlta = { ok: true; tenant: Tenant; usuario: string; password: string } | { ok: false; error: string };

/** Valida y normaliza el cuerpo del alta de negocio. Devuelve el Tenant + credenciales o un error. */
export function validarAltaTenant(body: any): ResultadoAlta {
  if (!body || typeof body !== "object") return { ok: false, error: "Datos inválidos" };
  const t = body.tenant;
  if (!t || typeof t !== "object") return { ok: false, error: "Falta la configuración del negocio" };

  const id = String(t.id ?? "").trim().toLowerCase();
  if (!RE_SLUG.test(id) || id.length < 3 || id.length > 50) {
    return { ok: false, error: "El id del negocio debe ser un slug (minúsculas, números y guiones), de 3 a 50 caracteres" };
  }
  const nombre = String(t.nombre ?? "").trim();
  if (!nombre || nombre.length > 80) return { ok: false, error: "El nombre del negocio es obligatorio (máx 80)" };

  const phoneNumberId = String(t.phoneNumberId ?? "").trim();
  if (!/^\d{5,30}$/.test(phoneNumberId)) return { ok: false, error: "El phone_number_id debe ser numérico (5 a 30 dígitos)" };

  const ubicacion = String(t.ubicacion ?? "").trim();
  if (!ubicacion || ubicacion.length > 1000) return { ok: false, error: "La ubicación es obligatoria (máx 1000)" };

  const vToken = validarAccessToken(t.accessToken);
  if (!vToken.ok) return { ok: false, error: vToken.error };
  const accessToken = vToken.token;

  const timezone = String(t.timezone ?? "").trim() || "America/Costa_Rica";
  const moneda = String(t.moneda ?? "").trim() || "₡";

  // Perfil del negocio (B7, motor multi-mercado): textos libres acotados + registro validado.
  const tipoNegocio = limpiarTexto(t.tipoNegocio, 120);
  const pais = limpiarTexto(t.pais, 60);
  const formasPago = limpiarTexto(t.formasPago, 300);
  const registro = validarRegistro(t.registro);
  const tono = limpiarTexto(t.tono, 120);
  const instrucciones = limpiarTexto(t.instrucciones, 4000);

  let intervaloAgendaMin = 30;
  if (t.intervaloAgendaMin !== undefined && t.intervaloAgendaMin !== null && t.intervaloAgendaMin !== "") {
    const n = Number(t.intervaloAgendaMin);
    if (!Number.isInteger(n) || n < 5 || n > 120) return { ok: false, error: "El intervalo de agenda debe ser un entero entre 5 y 120" };
    intervaloAgendaMin = n;
  }

  const horario = validarHorario(t.horario);
  if (!horario) return { ok: false, error: "Horario inválido (usá formato HH:mm, con la hora de cierre después de la de apertura, o vacío para día cerrado)" };

  const resServicios = validarServicios(t.servicios ?? []);
  if (!resServicios.ok) return { ok: false, error: resServicios.error };
  const servicios = resServicios.servicios;

  const kb: KnowledgeBase = {
    faq: validarFaq(t.kb?.faq),
    datos: limpiarLineas(t.kb?.datos),
    politicas: limpiarLineas(t.kb?.politicas),
    secciones: validarSecciones(t.kb?.secciones),
  };
  // Tope de tamaño de la KB (ALTO-16 / F13): mismo criterio en el alta que en la config
  // self-service de abajo, para que un negocio no pueda arrancar ya por encima del límite.
  const errorTamanoKb = validarTamanoKb(kb);
  if (errorTamanoKb) return { ok: false, error: errorTamanoKb };

  const usuario = String(body.usuario ?? "").trim();
  if (!RE_USUARIO.test(usuario)) return { ok: false, error: "Usuario inválido (3 a 40 caracteres: letras, números, . _ -)" };
  if (usuario === process.env.PANEL_SUPERADMIN_USUARIO) return { ok: false, error: "Ese usuario está reservado" };
  const password = String(body.password ?? "");
  if (password.length < 8) return { ok: false, error: "La contraseña del panel debe tener al menos 8 caracteres" };

  const tenant: Tenant = {
    id,
    nombre,
    phoneNumberId,
    accessToken,
    timezone,
    moneda,
    ubicacion,
    intervaloAgendaMin,
    horario,
    servicios,
    kb,
    bloqueos: [],
    // El equipo se carga después, desde "Mi negocio": un alta sin empleados arranca en
    // modo recurso único, que es lo correcto para el negocio de una sola persona.
    empleados: [],
    // C4.3: los negocios nuevos arrancan en Básico — Pro se desbloquea pagando desde la
    // pestaña "Facturación" del panel (el piloto ya existente quedó en "pro" gratis por
    // la migración aditiva, esto NO afecta tenants ya creados).
    plan: "basico",
    ...(tipoNegocio && { tipoNegocio }),
    ...(pais && { pais }),
    ...(formasPago && { formasPago }),
    ...(registro && { registro }),
    ...(tono && { tono }),
    ...(instrucciones && { instrucciones }),
  };
  return { ok: true, tenant, usuario, password };
}

/** Mapea un choque de índice único de Postgres (23505) a un mensaje claro. */
/** Arma y valida un SegmentoFiltro (ROADMAP C3.2) desde un `URLSearchParams` (preview). */
export function leerSegmentoFiltro(q: URLSearchParams, tenant: Tenant): SegmentoFiltro | null {
  return validarSegmentoFiltro(
    { tipo: q.get("tipo"), dias: q.get("dias"), servicioId: q.get("servicioId"), meses: q.get("meses") },
    tenant,
  );
}

/** Misma validación, desde el body JSON de crear campaña. */
export function leerSegmentoFiltroDeBody(body: any, tenant: Tenant): SegmentoFiltro | null {
  return validarSegmentoFiltro(
    { tipo: body?.segmentoTipo, dias: body?.dias, servicioId: body?.servicioId, meses: body?.meses },
    tenant,
  );
}

export function validarSegmentoFiltro(
  raw: { tipo: unknown; dias: unknown; servicioId: unknown; meses: unknown },
  tenant: Tenant,
): SegmentoFiltro | null {
  const tipo = raw.tipo;
  if (tipo !== "todos" && tipo !== "inactivos" && tipo !== "servicio_antiguo") return null;
  if (tipo === "todos") return { tipo };
  if (tipo === "inactivos") {
    const dias = Number(raw.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return null;
    return { tipo, dias };
  }
  // "servicio_antiguo"
  const servicioId = String(raw.servicioId ?? "");
  if (!tenant.servicios.some((s) => s.id === servicioId)) return null;
  const meses = Number(raw.meses);
  if (!Number.isInteger(meses) || meses < 1 || meses > 120) return null;
  return { tipo, servicioId, meses };
}

/**
 * Error de Postgres "de verdad" detrás de una excepción de Drizzle: desde drizzle-orm
 * 0.44 los errores de query llegan envueltos (`DrizzleQueryError`) con el original en
 * `cause`, así que `e.code`/`e.constraint_name` pueden no estar en el primer nivel.
 */
export function errorPg(e: unknown): { code?: string; constraint_name?: string; constraint?: string } {
  const x = e as { code?: string; cause?: unknown };
  if (x?.code) return x as { code?: string; constraint_name?: string };
  return (x?.cause as { code?: string; constraint_name?: string }) ?? {};
}

/** true si el error es un choque de índice único (23505), envuelto o no. */
export function esChoqueUnico(e: unknown): boolean {
  return errorPg(e).code === "23505";
}

export function mensajeConflicto(e: unknown): string {
  const pg = errorPg(e);
  const nombre = pg.constraint_name ?? pg.constraint;
  if (nombre === "wa_tenants_pkey") return "Ya existe un negocio con ese id";
  if (nombre === "wa_tenants_pnid_uq") return "Ese phone_number_id ya está en uso por otro negocio";
  if (nombre === "wa_usuarios_usuario_uq") return "Ese usuario de panel ya existe";
  return "Ya existe un registro con esos datos (id, phone_number_id o usuario duplicado)";
}

/**
 * Rastro en wa_auditoria de una acción del superadmin que NO tiene su propia transacción
 * (login, reset de clave). Best-effort: sin base, o si el INSERT falla, la acción sigue
 * (no se le niega el login al admin porque la auditoría no respondió) y queda en el log.
 */
export async function auditarPlataforma(
  tenantId: string,
  accion: AccionAuditoria,
  detalle: Record<string, unknown> = {},
): Promise<void> {
  if (!hayBaseDeDatos()) return;
  try {
    await registrarAuditoria(obtenerDb(), tenantId, accion, actorSuperadmin(), detalle);
  } catch (e) {
    console.error(`[auditoria] no se pudo registrar ${accion}:`, e);
  }
}

// Freno a la enumeración de usuarios al crear cuentas (revisión de seguridad 2026-10):
// los nombres de usuario son únicos en TODO el sistema, así que el 409 "ya existe" le
// dice a un dueño que ese usuario existe en ALGÚN negocio. No se puede evitar sin cambiar
// el login (el usuario no lleva el negocio), pero sí acotar el ritmo: pocos choques por
// negocio por hora; pasado eso, 429. En memoria, por proceso (alcanza para el volumen).
const MAX_CHOQUES_USUARIO_HORA = 10;
const choquesAltaUsuario = new Map<string, number[]>();
export function demasiadosChoquesDeUsuario(tenantId: string): boolean {
  const ahora = Date.now();
  const recientes = (choquesAltaUsuario.get(tenantId) ?? []).filter((t) => ahora - t < 60 * 60 * 1000);
  if (recientes.length) choquesAltaUsuario.set(tenantId, recientes);
  else choquesAltaUsuario.delete(tenantId);
  return recientes.length >= MAX_CHOQUES_USUARIO_HORA;
}
export function registrarChoqueDeUsuario(tenantId: string): void {
  const lista = choquesAltaUsuario.get(tenantId) ?? [];
  lista.push(Date.now());
  choquesAltaUsuario.set(tenantId, lista);
}
