import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actualizarConfigTenant,
  actualizarFacturacionTenant,
  actualizarUsuarioTenant,
  cambiarClavePropia,
  crearTenant,
  crearUsuarioTenant,
  hayBaseDeDatos,
  listarTenants,
  listarUsuariosDeTenant,
  obtenerTenantPorId,
  obtenerUsuario,
  obtenerUsuarioPorId,
  recargar,
  resetearClaveUsuario,
} from "../config/tenantStore";
import {
  limpiarLineas,
  limpiarTexto,
  validarBloqueos,
  validarColorHex,
  validarFaq,
  validarGooglePlaceId,
  validarHorario,
  validarLinkResenas,
  validarLogoUrl,
  validarNombrePlantillaMarketing,
  validarNombrePlantillaReapertura,
  validarNombrePlantillaRescate,
  validarRegistro,
  validarRescateHoras,
  validarSecciones,
  validarServicios,
  validarTextoRescate,
} from "../config/validadores";
import { enviarPlantilla, enviarTexto } from "../whatsapp/client";
import {
  configPublica as esConfigPublica,
  embeddedSignupConfigurado,
  guardarTokenTemporal,
  intercambiarCodigo,
  registrarNumero,
  suscribirApp,
  tomarToken,
} from "../whatsapp/embeddedSignup";
import type { Cita, EstadoConversacion, KnowledgeBase, Plan, Repositorio, Rol, SegmentoFiltro, Tenant } from "../types";
import { featuresDeTenant, tenantPuede } from "../billing/planes";
import { listarUsoMensualActual } from "../observabilidad/uso";
import {
  cancelarCampania,
  confirmarEnvioCampania,
  crearCampania,
  listarCampanias,
  obtenerCampania,
} from "../campaigns/campanias";
import { previsualizarSegmento } from "../campaigns/segmentos";
import { espaciosDisponibles } from "../booking/availability";
import {
  hoyEnTz,
  sincronizarCancelacionGcal,
  sincronizarCreacionGcal,
  sincronizarReprogramacionGcal,
} from "../booking/gestionCitas";
import {
  crearSesion,
  crearSesionAdmin,
  generarClaveTemporal,
  hashearPassword,
  HASH_DUMMY,
  verificarPassword,
  verificarSesion,
  verificarSesionAdmin,
} from "./auth";
import { clavePublicaVapid, enviarPushATenant } from "./push";

// ─────────────────────────────────────────────────────────────────────────────
// Panel web (bandeja humana). Maneja las rutas /panel, /panel/* y /api/panel/*.
// Devuelve true si manejó la request; false si no es ruta del panel.
// ─────────────────────────────────────────────────────────────────────────────

const COOKIE = "panel_sesion";
const COOKIE_ADMIN = "panel_admin_sesion"; // sesión del superadmin (onboarding), aparte de la del operador

// Fuentes self-hosted (woff2 y ttf). Se cachean en memoria al primer pedido.
const fontCache = new Map<string, Buffer>();
function leerFuente(file: string): { buf: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(woff2|ttf)$/.test(file)) return null;
  const cached = fontCache.get(file);
  const mime = file.endsWith(".ttf") ? "font/ttf" : "font/woff2";
  if (cached) return { buf: cached, mime };
  try {
    const buf = readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));
    fontCache.set(file, buf);
    return { buf, mime };
  } catch {
    return null;
  }
}

// Assets de la PWA (íconos, manifest, service worker). Allowlist + caché en memoria.
const assetCache = new Map<string, Buffer>();
function leerAsset(rel: string): Buffer | null {
  if (rel !== "sw.js" && rel !== "manifest.webmanifest" && !/^icons\/[a-z0-9-]+\.png$/.test(rel)) {
    return null;
  }
  const cached = assetCache.get(rel);
  if (cached) return cached;
  try {
    const buf = readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)));
    assetCache.set(rel, buf);
    return buf;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build de React (Vite) del panel (web/dist). Si no existe devuelve null → 503.
// ─────────────────────────────────────────────────────────────────────────────
function rutaDist(rel: string): string {
  return fileURLToPath(new URL(`../../web/dist/${rel}`, import.meta.url));
}

let _reactIndex: string | null | undefined; // undefined = sin chequear; null = no hay build
function leerReactIndex(): string | null {
  // En dev (SEED_DEMO) se re-lee por si se rebuildó; igual lo normal en dev es usar
  // el server de Vite (puerto 5173) con HMR, no este build servido por Node.
  if (process.env.SEED_DEMO) {
    try {
      return readFileSync(rutaDist("index.html"), "utf8");
    } catch {
      return null;
    }
  }
  if (_reactIndex === undefined) {
    try {
      _reactIndex = readFileSync(rutaDist("index.html"), "utf8");
    } catch {
      _reactIndex = null;
    }
  }
  return _reactIndex;
}

// Assets hasheados del build (/panel/assets/*). Allowlist estricta (un solo
// segmento, extensión conocida, sin "..") → sin path traversal. Caché en memoria.
const TIPOS_ASSET: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};
const distAssetCache = new Map<string, Buffer>();
function leerDistAsset(file: string): { buf: Buffer; tipo: string } | null {
  const m = /^([a-zA-Z0-9._-]+)\.([a-z0-9]+)$/.exec(file);
  if (!m || file.includes("..")) return null;
  const tipo = TIPOS_ASSET[m[2]];
  if (!tipo) return null;
  let buf = distAssetCache.get(file);
  if (!buf) {
    try {
      buf = readFileSync(rutaDist(`assets/${file}`));
    } catch {
      return null;
    }
    distAssetCache.set(file, buf);
  }
  return { buf, tipo };
}

// Archivos de la RAÍZ del build (no hasheados): sw.js, manifest.webmanifest, íconos.
// Los genera vite-plugin-pwa (carril A5). Misma allowlist que leerAsset; si existe el
// build, tiene prioridad sobre los de src/panel (fallback en migración). En dev
// (SEED_DEMO) no se cachea para poder iterar tras un rebuild.
const distRaizCache = new Map<string, Buffer>();
function leerDistRaiz(rel: string): Buffer | null {
  if (rel !== "sw.js" && rel !== "manifest.webmanifest" && !/^icons\/[a-z0-9-]+\.png$/.test(rel)) {
    return null;
  }
  if (!process.env.SEED_DEMO) {
    const cached = distRaizCache.get(rel);
    if (cached) return cached;
  }
  try {
    const buf = readFileSync(rutaDist(rel));
    distRaizCache.set(rel, buf);
    return buf;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function leerCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const par of raw.split(";")) {
    const i = par.indexOf("=");
    if (i > -1) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}

const MAX_BODY = 64 * 1024; // 64 KB: los cuerpos del panel son chicos (texto/notas/login)
/** Lee el cuerpo JSON con tope de tamaño. Devuelve null si excede el límite. */
async function leerBody(req: IncomingMessage): Promise<any | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) return null; // demasiado grande → el caller responde 413
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Acepta el request solo si el Origin/Referer coincide con el host (anti-CSRF). */
function mismoOrigen(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const fuente = req.headers.origin ?? req.headers.referer;
  if (!fuente) return false; // un POST que cambia estado sin Origin/Referer → rechazar
  try {
    return new URL(fuente).host === host;
  } catch {
    return false;
  }
}

/** Sesión de operador ya resuelta contra el tenantStore (tenant + quién + su rol). */
interface SesionPanel {
  tenant: Tenant;
  usuarioId: string;
  rol: Rol;
}

/** Devuelve la sesión del operador (tenant, usuarioId, rol), o null si no está autenticado. */
function sesionDeOperador(req: IncomingMessage): SesionPanel | null {
  const s = verificarSesion(leerCookies(req)[COOKIE]);
  if (!s) return null;
  const tenant = obtenerTenantPorId(s.tenantId);
  if (!tenant) return null;
  return { tenant, usuarioId: s.usuarioId, rol: s.rol };
}

/** true si el request trae una sesión de superadmin válida (onboarding, ROADMAP B3). */
function esAdmin(req: IncomingMessage): boolean {
  return verificarSesionAdmin(leerCookies(req)[COOKIE_ADMIN]);
}

// ── Validación del alta de negocios (server-side; no confiar en el cliente) ──
// Los validadores de horario/servicios/faq/bloqueos viven en ../config/validadores,
// compartidos con la config self-service (ROADMAP C2.2).
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;

type ResultadoAlta = { ok: true; tenant: Tenant; usuario: string; password: string } | { ok: false; error: string };

/** Valida y normaliza el cuerpo del alta de negocio. Devuelve el Tenant + credenciales o un error. */
function validarAltaTenant(body: any): ResultadoAlta {
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

  const accessToken = t.accessToken ? String(t.accessToken).trim() : undefined;
  if (accessToken && accessToken.length > 512) return { ok: false, error: "El accessToken es demasiado largo" };

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
  if (!horario) return { ok: false, error: "Horario inválido (usá formato HH:mm, o vacío para día cerrado)" };

  const resServicios = validarServicios(t.servicios ?? []);
  if (!resServicios.ok) return { ok: false, error: resServicios.error };
  const servicios = resServicios.servicios;

  const kb: KnowledgeBase = {
    faq: validarFaq(t.kb?.faq),
    datos: limpiarLineas(t.kb?.datos),
    politicas: limpiarLineas(t.kb?.politicas),
    secciones: validarSecciones(t.kb?.secciones),
  };

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
function leerSegmentoFiltro(q: URLSearchParams, tenant: Tenant): SegmentoFiltro | null {
  return validarSegmentoFiltro(
    { tipo: q.get("tipo"), dias: q.get("dias"), servicioId: q.get("servicioId"), meses: q.get("meses") },
    tenant,
  );
}

/** Misma validación, desde el body JSON de crear campaña. */
function leerSegmentoFiltroDeBody(body: any, tenant: Tenant): SegmentoFiltro | null {
  return validarSegmentoFiltro(
    { tipo: body?.segmentoTipo, dias: body?.dias, servicioId: body?.servicioId, meses: body?.meses },
    tenant,
  );
}

function validarSegmentoFiltro(
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

function mensajeConflicto(e: unknown): string {
  const nombre = (e as { constraint_name?: string }).constraint_name;
  if (nombre === "wa_tenants_pkey") return "Ya existe un negocio con ese id";
  if (nombre === "wa_tenants_pnid_uq") return "Ese phone_number_id ya está en uso por otro negocio";
  if (nombre === "wa_usuarios_usuario_uq") return "Ese usuario de panel ya existe";
  return "Ya existe un registro con esos datos (id, phone_number_id o usuario duplicado)";
}

export async function manejarPanel(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repositorio,
  pathname: string,
): Promise<boolean> {
  const metodo = req.method ?? "GET";

  // ── Assets hasheados del build de React (/panel/assets/*) ──
  if (pathname.startsWith("/panel/assets/")) {
    const asset = leerDistAsset(pathname.slice("/panel/assets/".length));
    if (!asset) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    res.writeHead(200, {
      "content-type": asset.tipo,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(asset.buf);
    return true;
  }

  // ── Fuentes self-hosted (woff2 y ttf) ──
  if (pathname.startsWith("/panel/fonts/")) {
    const fuente = leerFuente(pathname.slice("/panel/fonts/".length));
    if (!fuente) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    res.writeHead(200, { "content-type": fuente.mime, "cache-control": "public, max-age=31536000, immutable" });
    res.end(fuente.buf);
    return true;
  }

  // ── Assets de la PWA: service worker, manifest e íconos ──
  // Prioridad al build de React (web/dist, generado por vite-plugin-pwa); si no hay
  // build, se cae a los de src/panel (panel viejo) — migración sin riesgo.
  if (pathname === "/panel/sw.js" || pathname === "/panel/manifest.webmanifest" || pathname.startsWith("/panel/icons/")) {
    const rel = pathname.slice("/panel/".length);
    const buf = leerDistRaiz(rel) ?? leerAsset(rel);
    if (!buf) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    const headers: Record<string, string> = {};
    if (rel === "sw.js") {
      headers["content-type"] = "text/javascript; charset=utf-8";
      headers["cache-control"] = "no-cache"; // el navegador revalida el SW seguido
      headers["service-worker-allowed"] = "/panel/";
    } else if (rel === "manifest.webmanifest") {
      headers["content-type"] = "application/manifest+json; charset=utf-8";
      headers["cache-control"] = "max-age=3600";
    } else {
      headers["content-type"] = "image/png";
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  }

  // ── Fallback SPA (React Router) ──
  // Cualquier /panel/* de PÁGINA (no asset, no /api) sirve el index del build, para que
  // el deep-link a una ruta cliente (p. ej. /panel/admin) funcione en carga completa.
  // Va DESPUÉS de los bloques de assets (que ya hacen return) y ANTES del check de /api,
  // así no sombrea ni los assets ni /api/panel/*.
  if (pathname === "/panel" || pathname.startsWith("/panel/")) {
    if (metodo !== "GET" && metodo !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    }
    const react = leerReactIndex();
    if (!react) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Panel no disponible — corré `npm run web:build` y reiniciá el proceso.");
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(react);
    return true;
  }

  if (!pathname.startsWith("/api/panel/")) return false;
  const ruta = pathname.slice("/api/panel/".length).replace(/\/$/, "");

  // CSRF: todo POST del panel cambia estado y debe venir del mismo origen.
  if (metodo === "POST" && !mismoOrigen(req)) {
    json(res, 403, { ok: false, error: "Origen no permitido" });
    return true;
  }

  // ── Onboarding: API del superadmin (ROADMAP B3). Comparte el guard CSRF de arriba. ──
  if (ruta === "admin/login" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const usuarioOk = !!process.env.PANEL_SUPERADMIN_USUARIO && body?.usuario === process.env.PANEL_SUPERADMIN_USUARIO;
    // scrypt SIEMPRE (HASH_DUMMY si falta config/usuario) → no filtra por timing.
    const passOk = verificarPassword(String(body?.password ?? ""), process.env.PANEL_SUPERADMIN_HASH ?? HASH_DUMMY);
    if (!usuarioOk || !passOk) {
      json(res, 401, { ok: false, error: "Usuario o contraseña incorrectos" });
      return true;
    }
    const cookie = `${COOKIE_ADMIN}=${crearSesionAdmin()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (ruta === "admin/logout" && metodo === "POST") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${COOKIE_ADMIN}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
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
      const tenants = listarTenants().map((t) => ({
        id: t.id,
        nombre: t.nombre,
        phoneNumberId: t.phoneNumberId,
        moneda: t.moneda,
        timezone: t.timezone,
        servicios: t.servicios.length,
        plan: t.plan,
        conversacionesEsteMes: uso.get(t.id)?.conversacionesIniciadas ?? 0,
      }));
      json(res, 200, { ok: true, tenants });
      return true;
    }

    // Cambio de plan Básico↔Pro desde el admin (Carril D, 0.1): sin redeploy, habilita
    // o quita Campañas/Usuarios/White-label de inmediato (el caché se recarga al final).
    const partesPlan = ruta.split("/");
    if (partesPlan[0] === "admin" && partesPlan[1] === "tenants" && partesPlan[2] && partesPlan[3] === "plan" && metodo === "POST") {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "El cambio de plan requiere base de datos (no configurada)." }), true;
      }
      const tenantId = decodeURIComponent(partesPlan[2]);
      if (!obtenerTenantPorId(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
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
        await crearTenant(v.tenant, { usuario: v.usuario, passwordHash: hashearPassword(v.password) });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") return json(res, 409, { ok: false, error: mensajeConflicto(e) }), true;
        if (e instanceof Error && e.message === "SIN_DB") {
          return json(res, 503, { ok: false, error: "El alta de negocios requiere base de datos." }), true;
        }
        console.error("[admin] crearTenant:", e);
        return json(res, 500, { ok: false, error: "No se pudo crear el negocio." }), true;
      }
      await recargar(); // el negocio queda vivo en el caché sin reiniciar el proceso
      return json(res, 201, { ok: true, tenantId: v.tenant.id }), true;
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
      if (!obtenerTenantPorId(tenantId)) return json(res, 404, { ok: false, error: "Negocio no encontrado" }), true;
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
        usuario = await resetearClaveUsuario(usuarioId, hashearPassword(claveTemporal), expiraEn);
      } catch (e) {
        if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
        console.error("[admin] resetearClaveUsuario:", e);
        return json(res, 500, { ok: false, error: "No se pudo resetear la clave." }), true;
      }
      if (!usuario) return json(res, 404, { ok: false, error: "Usuario no encontrado" }), true;
      return json(res, 200, { ok: true, usuario: usuario.usuario, claveTemporal, expiraEn: expiraEn.toISOString() }), true;
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;
  }

  // ── Login ──
  if (ruta === "login" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const { usuario, password } = body;
    // Resuelve usuario → cuenta (wa_usuarios) → tenant, vía el caché del tenantStore.
    const cuenta = obtenerUsuario(String(usuario ?? ""));
    // Corremos scrypt SIEMPRE (con un hash dummy si el usuario no existe) para no
    // filtrar por timing qué usuarios son válidos. El 401 es idéntico en ambos casos.
    const ok = verificarPassword(String(password ?? ""), cuenta?.passwordHash ?? HASH_DUMMY);
    const tenant = cuenta ? obtenerTenantPorId(cuenta.tenantId) : undefined;
    // Clave temporal del reset de admin (0.5): vencida a las 24h, hay que pedir un reset nuevo.
    const claveVencida = !!cuenta?.claveTemporalExpira && Date.now() > cuenta.claveTemporalExpira.getTime();
    if (!cuenta || !ok || !tenant || claveVencida) {
      const error = claveVencida
        ? "La clave temporal venció. Pedile a tu administrador que te la resetee de nuevo."
        : "Usuario o contraseña incorrectos";
      json(res, 401, { ok: false, error });
      return true;
    }
    const cookie = `${COOKIE}=${crearSesion(tenant.id, cuenta.id, cuenta.rol)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie });
    res.end(JSON.stringify({ ok: true, nombre: tenant.nombre, vapidPublica: clavePublicaVapid() }));
    return true;
  }

  if (ruta === "logout" && metodo === "POST") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── A partir de acá, todo requiere sesión ──
  const sesion = sesionDeOperador(req);
  if (!sesion) {
    json(res, 401, { ok: false, error: "No autenticado" });
    return true;
  }
  const { tenant, rol, usuarioId } = sesion;

  if (ruta === "me" && metodo === "GET") {
    json(res, 200, {
      ok: true,
      nombre: tenant.nombre,
      tenantId: tenant.id,
      usuarioId,
      rol,
      // Reset de contraseña desde el admin (Carril D, 0.5): el panel fuerza el cambio
      // de clave antes de mostrar nada más mientras esto esté en true.
      debeCambiarClave: obtenerUsuarioPorId(usuarioId)?.debeCambiarClave ?? false,
      vapidPublica: clavePublicaVapid(),
      servicios: tenant.servicios.filter((s) => s.agendable),
      // White-label (C4.1): el panel se pinta con esto al cargar (ver web/src/lib/marca.ts).
      marca: {
        colorAcento: tenant.colorAcento ?? null,
        colorHeader: tenant.colorHeader ?? null,
        logoUrl: tenant.logoUrl ?? null,
      },
      // Gating de planes (Carril D, 0.1): el panel muestra/oculta sin adivinar.
      plan: tenant.plan,
      features: featuresDeTenant(tenant),
      // Ventana de 24h (Carril D, 0.3): si hay plantilla de reapertura configurada,
      // el chat ofrece el botón "Reabrir conversación" fuera de ventana.
      reaperturaConfigurada: !!tenant.plantillaReapertura,
    });
    return true;
  }

  // Cambio de clave propio (Carril D, 0.5): lo usa tanto el cambio obligatorio tras un
  // reset del admin como un cambio voluntario. Requiere la clave actual (o la temporal).
  if (ruta === "cambiar-clave" && metodo === "POST") {
    if (!hayBaseDeDatos()) return json(res, 503, { ok: false, error: "Requiere base de datos (no configurada)." }), true;
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const claveActual = String(body?.claveActual ?? "");
    const claveNueva = String(body?.claveNueva ?? "");
    if (claveNueva.length < 8) return json(res, 400, { ok: false, error: "La contraseña debe tener al menos 8 caracteres" }), true;
    const cuenta = obtenerUsuarioPorId(usuarioId);
    if (!cuenta || !verificarPassword(claveActual, cuenta.passwordHash)) {
      return json(res, 401, { ok: false, error: "La contraseña actual no es correcta" }), true;
    }
    try {
      await cambiarClavePropia(tenant.id, usuarioId, hashearPassword(claveNueva));
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") return json(res, 503, { ok: false, error: "Requiere base de datos." }), true;
      console.error("[panel] cambiarClavePropia:", e);
      return json(res, 500, { ok: false, error: "No se pudo cambiar la contraseña." }), true;
    }
    await recargar();
    return json(res, 200, { ok: true }), true;
  }

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
      if (usuario === process.env.PANEL_SUPERADMIN_USUARIO) {
        return json(res, 400, { ok: false, error: "Ese usuario está reservado" }), true;
      }
      const password = String(body?.password ?? "");
      if (password.length < 8) return json(res, 400, { ok: false, error: "La contraseña debe tener al menos 8 caracteres" }), true;
      const nuevoRol: Rol = body?.rol === "dueno" ? "dueno" : "operador";
      try {
        await crearUsuarioTenant(tenant.id, { usuario, passwordHash: hashearPassword(password), rol: nuevoRol });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") return json(res, 409, { ok: false, error: "Ese usuario de panel ya existe" }), true;
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

  // ── Campañas segmentadas (ROADMAP C3.2) — solo dueño, requiere base de datos ──
  if (ruta === "campanias" || ruta.startsWith("campanias/")) {
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede gestionar campañas" }), true;
    }
    if (!tenantPuede(tenant, "campanias")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "Las campañas requieren base de datos (no configurada)." }), true;
    }

    if (ruta === "campanias" && metodo === "GET") {
      const campanias = await listarCampanias(tenant.id);
      return json(res, 200, { ok: true, campanias }), true;
    }

    if (ruta === "campanias/segmento/preview" && metodo === "GET") {
      const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
      const filtro = leerSegmentoFiltro(q, tenant);
      if (!filtro) return json(res, 400, { ok: false, error: "Segmento inválido" }), true;
      const destinatarios = await previsualizarSegmento(tenant.id, filtro);
      return json(res, 200, { ok: true, total: destinatarios.length, muestra: destinatarios.slice(0, 20) }), true;
    }

    if (ruta === "campanias" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;

      const nombre = String(body?.nombre ?? "").trim();
      if (!nombre || nombre.length > 80) {
        return json(res, 400, { ok: false, error: "Nombre inválido (1 a 80 caracteres)" }), true;
      }
      const mensaje = String(body?.mensaje ?? "").trim();
      if (!mensaje || mensaje.length > 300) {
        return json(res, 400, { ok: false, error: "Mensaje inválido (1 a 300 caracteres)" }), true;
      }
      const filtro = leerSegmentoFiltroDeBody(body, tenant);
      if (!filtro) return json(res, 400, { ok: false, error: "Segmento inválido" }), true;

      const campania = await crearCampania(tenant.id, { nombre, mensaje, segmentoTipo: filtro.tipo, segmentoParametros: filtro });
      return json(res, 201, { ok: true, campania }), true;
    }

    // /campanias/{id} y /campanias/{id}/{accion}
    const partes = ruta.split("/");
    const campaniaId = partes[1] ? decodeURIComponent(partes[1]) : null;
    if (!campaniaId) return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;

    if (partes.length === 2 && metodo === "GET") {
      const campania = await obtenerCampania(tenant.id, campaniaId);
      if (!campania) return json(res, 404, { ok: false, error: "Campaña no encontrada" }), true;
      return json(res, 200, { ok: true, campania }), true;
    }

    if (partes.length === 3 && partes[2] === "enviar" && metodo === "POST") {
      if (!tenant.plantillaMarketing) {
        return json(res, 400, {
          ok: false,
          error: "Configurá la plantilla de marketing en \"Mi negocio\" antes de enviar campañas",
        }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const programadaPara = body?.programadaPara ? String(body.programadaPara) : null;
      if (programadaPara && Number.isNaN(new Date(programadaPara).getTime())) {
        return json(res, 400, { ok: false, error: "Fecha de programación inválida" }), true;
      }
      try {
        const campania = await confirmarEnvioCampania(tenant.id, campaniaId, programadaPara);
        return json(res, 200, { ok: true, campania }), true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "NO_ENCONTRADA") return json(res, 404, { ok: false, error: "Campaña no encontrada" }), true;
        if (msg === "YA_ENVIADA") return json(res, 400, { ok: false, error: "Esa campaña ya se envió o está en curso" }), true;
        if (msg === "SIN_DESTINATARIOS") return json(res, 400, { ok: false, error: "El segmento no tiene destinatarios" }), true;
        console.error("[campanias] confirmarEnvioCampania:", e);
        return json(res, 500, { ok: false, error: "No se pudo confirmar el envío." }), true;
      }
    }

    if (partes.length === 3 && partes[2] === "cancelar" && metodo === "POST") {
      const campania = await cancelarCampania(tenant.id, campaniaId);
      if (!campania) return json(res, 404, { ok: false, error: "Campaña no encontrada o ya finalizada" }), true;
      return json(res, 200, { ok: true, campania }), true;
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;
  }

  // ── Config self-service del negocio (ROADMAP C2.2) ──
  if (ruta === "config" && metodo === "GET") {
    json(res, 200, {
      ok: true,
      horario: tenant.horario,
      servicios: tenant.servicios, // catálogo completo, sin filtrar por agendable (a diferencia de "me")
      kb: tenant.kb,
      bloqueos: tenant.bloqueos,
      linkResenas: tenant.linkResenas ?? "",
      plantillaMarketing: tenant.plantillaMarketing ?? "",
      plantillaReapertura: tenant.plantillaReapertura ?? "",
      colorAcento: tenant.colorAcento ?? "",
      colorHeader: tenant.colorHeader ?? "",
      logoUrl: tenant.logoUrl ?? "",
      rescateActivo: tenant.rescateActivo ?? false,
      rescateHorasEspera: tenant.rescateHorasEspera ?? 3,
      rescateToque1Texto: tenant.rescateToque1Texto ?? "",
      rescateToque2Texto: tenant.rescateToque2Texto ?? "",
      rescatePlantilla: tenant.rescatePlantilla ?? "",
      googlePlaceId: tenant.googlePlaceId ?? "",
      tipoNegocio: tenant.tipoNegocio ?? "",
      pais: tenant.pais ?? "",
      formasPago: tenant.formasPago ?? "",
      registro: tenant.registro ?? "",
      tono: tenant.tono ?? "",
      instrucciones: tenant.instrucciones ?? "",
    });
    return true;
  }

  if (ruta === "config" && metodo === "POST") {
    // Editar "Mi negocio" es solo del dueño (C2.3) — igual que gestionar usuarios. No
    // alcanza con esconder la pestaña en el frontend: sin este check, un operador podría
    // mandar el POST a mano y editarla igual.
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede editar la configuración" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "La configuración requiere base de datos (no configurada)." }), true;
    }
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;

    const horario = validarHorario(body?.horario);
    if (!horario) return json(res, 400, { ok: false, error: "Horario inválido (usá formato HH:mm, o vacío para día cerrado)" }), true;

    const resServicios = validarServicios(body?.servicios ?? []);
    if (!resServicios.ok) return json(res, 400, { ok: false, error: resServicios.error }), true;
    const servicios = resServicios.servicios;

    // Upsell inteligente al agendar (Carril D, 1.2) es Pro, igual que campañas/white-label:
    // un Básico no puede activar un add-on aunque mande el POST directo.
    if (servicios.some((s) => s.addonActivo) && !tenantPuede(tenant, "upsell")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const bloqueos = validarBloqueos(body?.bloqueos ?? []);
    if (!bloqueos) return json(res, 400, { ok: false, error: "Hay un bloqueo inválido (fechas YYYY-MM-DD, desde ≤ hasta)" }), true;

    const linkResenas = validarLinkResenas(body?.linkResenas);
    if (linkResenas === null) return json(res, 400, { ok: false, error: "Link de reseñas inválido (debe ser una URL http o https)" }), true;

    const plantillaMarketing = validarNombrePlantillaMarketing(body?.plantillaMarketing);
    if (plantillaMarketing === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }

    const plantillaReapertura = validarNombrePlantillaReapertura(body?.plantillaReapertura);
    if (plantillaReapertura === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }

    const colorAcento = validarColorHex(body?.colorAcento);
    if (colorAcento === null) return json(res, 400, { ok: false, error: "Color de acento inválido (formato #rrggbb)" }), true;

    const colorHeader = validarColorHex(body?.colorHeader);
    if (colorHeader === null) return json(res, 400, { ok: false, error: "Color de encabezado inválido (formato #rrggbb)" }), true;

    const logoUrl = validarLogoUrl(body?.logoUrl);
    if (logoUrl === null) return json(res, 400, { ok: false, error: "URL del logo inválida (debe ser una URL http o https)" }), true;

    // White-label (C4.1) es Pro (Carril D, 0.1): un Básico no puede setear marca aunque
    // mande el POST directo, aunque sí puede guardar el resto de "Mi negocio" sin tocarla.
    if ((colorAcento || colorHeader || logoUrl) && !tenantPuede(tenant, "whiteLabel")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const rescateActivo = !!body?.rescateActivo;
    const rescateHorasEspera = validarRescateHoras(body?.rescateHorasEspera ?? 3);
    if (rescateHorasEspera === null) {
      return json(res, 400, { ok: false, error: "Horas de espera del rescate inválidas (1 a 72)" }), true;
    }
    const rescateToque1Texto = validarTextoRescate(body?.rescateToque1Texto);
    if (rescateToque1Texto === null) return json(res, 400, { ok: false, error: "Texto del primer toque inválido (máx. 300 caracteres)" }), true;
    const rescateToque2Texto = validarTextoRescate(body?.rescateToque2Texto);
    if (rescateToque2Texto === null) return json(res, 400, { ok: false, error: "Texto del segundo toque inválido (máx. 300 caracteres)" }), true;
    const rescatePlantilla = validarNombrePlantillaRescate(body?.rescatePlantilla);
    if (rescatePlantilla === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }
    // Rescate de cotizaciones (Carril D, 1.1) es Pro, igual que campañas/white-label.
    if (rescateActivo && !tenantPuede(tenant, "rescateCotizaciones")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const googlePlaceId = validarGooglePlaceId(body?.googlePlaceId);
    if (googlePlaceId === null) return json(res, 400, { ok: false, error: "Place ID de Google inválido" }), true;
    // Motor de reseñas completo (Carril D, 1.3) es Pro: un Básico no puede activar el
    // job de reputación aunque mande el POST directo.
    if (googlePlaceId && !tenantPuede(tenant, "resenasPro")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const kb: KnowledgeBase = {
      faq: validarFaq(body?.kb?.faq),
      datos: limpiarLineas(body?.kb?.datos),
      politicas: limpiarLineas(body?.kb?.politicas),
      secciones: validarSecciones(body?.kb?.secciones),
    };

    // Perfil del negocio (B7, motor multi-mercado): textos libres acotados + registro validado.
    const tipoNegocio = limpiarTexto(body?.tipoNegocio, 120);
    const pais = limpiarTexto(body?.pais, 60);
    const formasPago = limpiarTexto(body?.formasPago, 300);
    const registro = validarRegistro(body?.registro);
    const tono = limpiarTexto(body?.tono, 120);
    const instrucciones = limpiarTexto(body?.instrucciones, 4000);

    try {
      await actualizarConfigTenant(tenant.id, {
        horario,
        servicios,
        kb,
        bloqueos,
        linkResenas: linkResenas || null,
        plantillaMarketing: plantillaMarketing || null,
        plantillaReapertura: plantillaReapertura || null,
        colorAcento: colorAcento || null,
        colorHeader: colorHeader || null,
        logoUrl: logoUrl || null,
        rescateActivo,
        rescateHorasEspera,
        rescateToque1Texto: rescateToque1Texto || null,
        rescateToque2Texto: rescateToque2Texto || null,
        rescatePlantilla: rescatePlantilla || null,
        googlePlaceId: googlePlaceId || null,
        tipoNegocio: tipoNegocio || null,
        pais: pais || null,
        formasPago: formasPago || null,
        registro: registro || null,
        tono: tono || null,
        instrucciones: instrucciones || null,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") {
        return json(res, 503, { ok: false, error: "La configuración requiere base de datos." }), true;
      }
      console.error("[config] actualizarConfigTenant:", e);
      return json(res, 500, { ok: false, error: "No se pudo guardar la configuración." }), true;
    }
    await recargar(); // el cambio queda visible sin esperar el refresco periódico
    return json(res, 200, { ok: true }), true;
  }

  // ── Notificaciones push ──
  if (ruta === "push/suscribir" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) return json(res, 400, { ok: false, error: "Suscripción inválida" }), true;
    await repo.guardarPushSub(tenant.id, { endpoint: String(endpoint), p256dh: String(p256dh), auth: String(auth) });
    return json(res, 200, { ok: true }), true;
  }

  if (ruta === "push/desuscribir" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    if (body?.endpoint) await repo.borrarPushSub(String(body.endpoint));
    return json(res, 200, { ok: true }), true;
  }

  if (ruta === "push/probar" && metodo === "POST") {
    const r = await enviarPushATenant(repo, tenant.id, {
      title: "✅ Notificaciones activas",
      body: "Te avisaremos por acá cuando un cliente necesite atención.",
      url: "/panel/",
      tag: "prueba",
    });
    return json(res, 200, { ok: true, ...r }), true;
  }

  if (ruta === "conversaciones" && metodo === "GET") {
    json(res, 200, { ok: true, conversaciones: await repo.listarConversaciones(tenant.id) });
    return true;
  }

  if (ruta === "metricas" && metodo === "GET") {
    const m = await repo.metricas(tenant.id);
    const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
    m.serviciosTop = m.serviciosTop.map((s) => ({ ...s, nombre: nombreDe(s.servicioId) }));
    json(res, 200, { ok: true, metricas: m });
    return true;
  }

  // ── Agenda (C2.1) ──
  const fechaValida = (f: string) => /^\d{4}-\d{2}-\d{2}$/.test(f);
  const horaValida = (h: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h);

  if (ruta === "citas" && metodo === "GET") {
    const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
    const desde = q.get("desde") ?? "";
    const hasta = q.get("hasta") ?? "";
    if (!fechaValida(desde) || !fechaValida(hasta)) {
      return json(res, 400, { ok: false, error: "desde/hasta inválidos (usar YYYY-MM-DD)" }), true;
    }
    const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
    const citas = (await repo.citasEnRango(tenant.id, desde, hasta)).map((c) => ({
      ...c,
      servicioNombre: nombreDe(c.servicioId),
    }));
    return json(res, 200, { ok: true, citas }), true;
  }

  if (ruta === "citas/disponibilidad" && metodo === "GET") {
    const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
    const fecha = q.get("fecha") ?? "";
    const servicioId = q.get("servicioId") ?? "";
    if (!fechaValida(fecha)) return json(res, 400, { ok: false, error: "fecha inválida" }), true;
    const servicio = tenant.servicios.find((s) => s.id === servicioId && s.agendable);
    if (!servicio) return json(res, 400, { ok: false, error: "Servicio inválido" }), true;
    const citasDia = await repo.citasPorFecha(tenant.id, fecha);
    const libres = espaciosDisponibles(tenant, fecha, servicioId, citasDia);
    const ocupadas = citasDia
      .filter((c) => c.estado === "agendada")
      .map((c) => ({ hora: c.hora, citaId: c.id, clienteNombre: c.clienteNombre }));
    return json(res, 200, { ok: true, libres, ocupadas }), true;
  }

  if (ruta === "citas" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const clienteNombre = String(body.clienteNombre ?? "").trim();
    const clienteWa = String(body.clienteWa ?? "").trim();
    const servicioId = String(body.servicioId ?? "");
    const fecha = String(body.fecha ?? "");
    const hora = String(body.hora ?? "");
    const placa = body.placa ? String(body.placa).trim() : undefined;
    const precio =
      body.precio != null && !Number.isNaN(Number(body.precio)) ? Number(body.precio) : undefined;

    if (!clienteNombre || clienteNombre.length > 200) {
      return json(res, 400, { ok: false, error: "Nombre del cliente inválido" }), true;
    }
    if (!clienteWa || clienteWa.length > 40) {
      return json(res, 400, { ok: false, error: "Teléfono del cliente inválido" }), true;
    }
    const servicio = tenant.servicios.find((s) => s.id === servicioId && s.agendable);
    if (!servicio) return json(res, 400, { ok: false, error: "Servicio inválido" }), true;
    if (!fechaValida(fecha) || !horaValida(hora)) {
      return json(res, 400, { ok: false, error: "Formato de fecha/hora inválido" }), true;
    }
    if (fecha < hoyEnTz(tenant.timezone)) {
      return json(res, 400, { ok: false, error: "No se puede agendar una fecha pasada" }), true;
    }

    const cita: Cita = await repo.crearCita({
      tenantId: tenant.id,
      clienteWa,
      clienteNombre,
      servicioId,
      fecha,
      hora,
      placa,
      precio,
      origen: "manual",
    });
    await sincronizarCreacionGcal(tenant, repo, cita);
    // Rescate de cotizaciones (Carril D, 1.1): una cita creada a mano en la Agenda
    // también cierra una cotización activa del cliente para ese servicio.
    if (tenantPuede(tenant, "rescateCotizaciones")) {
      await repo
        .actualizarCotizacionPorCita(tenant.id, clienteWa, servicioId, cita.id, precio)
        .catch((e) => console.error("[rescate] actualizarCotizacionPorCita:", e));
    }
    return json(res, 200, { ok: true, cita }), true;
  }

  // /citas/{id}/{accion}
  const partesCita = ruta.split("/");
  if (partesCita[0] === "citas" && partesCita[1]) {
    const citaId = decodeURIComponent(partesCita[1]);
    const accion = partesCita[2];

    if (accion === "confirmar" && metodo === "POST") {
      const cita = await repo.confirmarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "completar" && metodo === "POST") {
      const cita = await repo.completarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "cancelar" && metodo === "POST") {
      const cita = await repo.cancelarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      await sincronizarCancelacionGcal(cita);
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "no-show" && metodo === "POST") {
      const cita = await repo.marcarNoShow(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "reprogramar" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const fecha = String(body.fecha ?? "");
      const hora = String(body.hora ?? "");
      if (!fechaValida(fecha) || !horaValida(hora)) {
        return json(res, 400, { ok: false, error: "Formato de fecha/hora inválido" }), true;
      }
      if (fecha < hoyEnTz(tenant.timezone)) {
        return json(res, 400, { ok: false, error: "No se puede reprogramar a una fecha pasada" }), true;
      }
      const cita = await repo.reprogramarCita(tenant.id, citaId, fecha, hora);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      await sincronizarReprogramacionGcal(tenant, cita);
      return json(res, 200, { ok: true, cita }), true;
    }
  }

  // /conversaciones/{id} y /conversaciones/{id}/{accion}
  const partes = ruta.split("/");
  if (partes[0] === "conversaciones" && partes[1]) {
    const convId = decodeURIComponent(partes[1]);
    const accion = partes[2];

    if (!accion && metodo === "GET") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      // Marcar leídas no debe bloquear la respuesta: corre en segundo plano.
      void repo.marcarLeidas(tenant.id, conv.id).catch((e) => console.error("[panel] marcarLeidas:", e));
      return json(res, 200, { ok: true, conversacion: conv }), true;
    }

    if (accion === "responder" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const t = String(body.texto ?? "").trim();
      if (!t) return json(res, 400, { ok: false, error: "Mensaje vacío" }), true;
      if (t.length > 4096) return json(res, 400, { ok: false, error: "El mensaje supera el límite de WhatsApp (4096)" }), true;

      // Ventana de 24h (Carril D, 0.3): fuera de ventana Meta rechaza el texto libre —
      // se corta acá con un error claro en vez de dejar que falle en enviarTexto.
      if (!conv.ventanaAbierta) {
        return json(res, 409, {
          ok: false,
          error: "ventana_cerrada",
          ventanaCierraEn: conv.ventanaCierraEn,
        }), true;
      }

      try {
        await enviarTexto(tenant, conv.clienteWa, t);
      } catch (e) {
        // El detalle (respuesta cruda de Meta, tokens, hosts) solo va al log del server.
        console.error("[panel] enviarTexto falló:", e);
        return json(res, 502, { ok: false, error: "No se pudo enviar el mensaje" }), true;
      }
      // Al responder un humano, la conversación queda en modo humano.
      if (conv.modo !== "humano") await repo.setModoConversacion(tenant.id, conv.id, "humano");
      await repo.guardarMensaje(conv.id, {
        rol: "assistant",
        contenido: t,
        creadoEn: new Date().toISOString(),
        porHumano: true,
      });
      await repo.marcarLeidas(tenant.id, conv.id);
      return json(res, 200, { ok: true }), true;
    }

    // Reabrir conversación fuera de la ventana de 24h (Carril D, 0.3): manda la
    // plantilla de UTILIDAD configurada en "Mi negocio" — el cliente responde y la
    // ventana vuelve a abrirse (mismo mecanismo que un mensaje entrante cualquiera).
    if (accion === "reabrir" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      if (conv.ventanaAbierta) {
        return json(res, 400, { ok: false, error: "La ventana ya está abierta, no hace falta reabrir" }), true;
      }
      if (!tenant.plantillaReapertura) {
        return json(res, 400, {
          ok: false,
          error: "Configurá la plantilla de reapertura en \"Mi negocio\" antes de reabrir conversaciones",
        }), true;
      }
      try {
        await enviarPlantilla(tenant, conv.clienteWa, tenant.plantillaReapertura, "es", [], "utilidad");
      } catch (e) {
        console.error("[panel] enviarPlantilla (reabrir) falló:", e);
        return json(res, 502, { ok: false, error: "No se pudo enviar la plantilla de reapertura" }), true;
      }
      await repo.guardarMensaje(conv.id, {
        rol: "assistant",
        contenido: "📩 Plantilla de reapertura enviada (conversación fuera de la ventana de 24h).",
        creadoEn: new Date().toISOString(),
        porHumano: true,
      });
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "modo" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const { modo } = body;
      if (modo !== "bot" && modo !== "humano") return json(res, 400, { ok: false, error: "modo inválido" }), true;
      await repo.setModoConversacion(tenant.id, conv.id, modo);
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "estado" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const estado: EstadoConversacion = body?.estado;
      if (estado !== "abierta" && estado !== "atendida") return json(res, 400, { ok: false, error: "estado inválido" }), true;
      await repo.marcarEstadoConversacion(tenant.id, conv.id, estado);
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "ficha" && metodo === "GET") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const ficha = await repo.fichaCliente(tenant.id, conv.clienteWa);
      if (!ficha) return json(res, 200, { ok: true, ficha: null }), true;
      const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
      const enriquecida = {
        ...ficha,
        historial: ficha.historial.map((h) => ({ ...h, servicioNombre: nombreDe(h.servicioId) })),
      };
      return json(res, 200, { ok: true, ficha: enriquecida }), true;
    }

    if (accion === "notas" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const notas = String(body.notas ?? "");
      if (notas.length > 4000) return json(res, 400, { ok: false, error: "Las notas son demasiado largas (máx 4000)" }), true;
      await repo.guardarNotas(tenant.id, conv.id, notas);
      return json(res, 200, { ok: true }), true;
    }
  }

  json(res, 404, { ok: false, error: "Ruta no encontrada" });
  return true;
}
