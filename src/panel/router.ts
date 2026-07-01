import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  crearTenant,
  hayBaseDeDatos,
  listarTenants,
  obtenerTenantPorId,
  obtenerUsuario,
  recargar,
} from "../config/tenantStore";
import { enviarTexto } from "../whatsapp/client";
import type { HorarioDia, KnowledgeBase, Repositorio, Service, Tenant } from "../types";
import {
  crearSesion,
  crearSesionAdmin,
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

// Fuentes self-hosted (woff2). Se cachean en memoria al primer pedido.
const fontCache = new Map<string, Buffer>();
function leerFuente(file: string): Buffer | null {
  if (!/^[a-z0-9-]+\.woff2$/.test(file)) return null;
  const cached = fontCache.get(file);
  if (cached) return cached;
  try {
    const buf = readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));
    fontCache.set(file, buf);
    return buf;
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

/** Devuelve el tenant de la sesión, o null si no está autenticado. */
function tenantDeSesion(req: IncomingMessage): Tenant | null {
  const tid = verificarSesion(leerCookies(req)[COOKIE]);
  if (!tid) return null;
  return obtenerTenantPorId(tid) ?? null;
}

/** true si el request trae una sesión de superadmin válida (onboarding, ROADMAP B3). */
function esAdmin(req: IncomingMessage): boolean {
  return verificarSesionAdmin(leerCookies(req)[COOKIE_ADMIN]);
}

// ── Validación del alta de negocios (server-side; no confiar en el cliente) ──
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

type ResultadoAlta = { ok: true; tenant: Tenant; usuario: string; password: string } | { ok: false; error: string };

function limpiarLineas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s ?? "").trim()).filter(Boolean);
}

function validarHorario(v: any): Record<number, HorarioDia> | null {
  const out: Record<number, HorarioDia> = {};
  for (let d = 0; d < 7; d++) {
    const dia = v && typeof v === "object" ? v[d] : undefined;
    if (dia === undefined || dia === null) {
      out[d] = { abre: "06:00", cierra: "18:00" }; // default razonable para días sin especificar
      continue;
    }
    const abre = dia.abre ?? null;
    const cierra = dia.cierra ?? null;
    if (abre === null && cierra === null) {
      out[d] = { abre: null, cierra: null }; // cerrado
      continue;
    }
    if (typeof abre !== "string" || typeof cierra !== "string" || !RE_HORA.test(abre) || !RE_HORA.test(cierra)) {
      return null;
    }
    out[d] = { abre, cierra };
  }
  return out;
}

function validarServicios(v: unknown): Service[] | null {
  if (!Array.isArray(v)) return null;
  const vistos = new Set<string>();
  const out: Service[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") return null;
    const r = s as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    const nombre = String(r.nombre ?? "").trim();
    const duracionMin = Number(r.duracionMin);
    if (!RE_SLUG.test(id) || id.length > 50 || vistos.has(id)) return null;
    if (!nombre || nombre.length > 120) return null;
    if (!Number.isInteger(duracionMin) || duracionMin <= 0 || duracionMin > 600) return null;
    vistos.add(id);
    const serv: Service = { id, nombre, duracionMin };
    if (r.agendable) serv.agendable = true;
    if (r.precioVariable) serv.precioVariable = true;
    if (r.precio !== undefined && r.precio !== null && r.precio !== "") {
      const p = Number(r.precio);
      if (!Number.isInteger(p) || p < 0) return null;
      serv.precio = p;
    }
    const precioNota = String(r.precioNota ?? "").trim();
    if (precioNota) serv.precioNota = precioNota.slice(0, 200);
    const descripcion = String(r.descripcion ?? "").trim();
    if (descripcion) serv.descripcion = descripcion.slice(0, 500);
    out.push(serv);
  }
  return out;
}

function validarFaq(v: unknown): { pregunta: string; respuesta: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { pregunta: string; respuesta: string }[] = [];
  for (const f of v) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const pregunta = String(r.pregunta ?? "").trim();
    const respuesta = String(r.respuesta ?? "").trim();
    if (pregunta && respuesta) out.push({ pregunta: pregunta.slice(0, 300), respuesta: respuesta.slice(0, 1000) });
  }
  return out;
}

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

  let intervaloAgendaMin = 30;
  if (t.intervaloAgendaMin !== undefined && t.intervaloAgendaMin !== null && t.intervaloAgendaMin !== "") {
    const n = Number(t.intervaloAgendaMin);
    if (!Number.isInteger(n) || n < 5 || n > 120) return { ok: false, error: "El intervalo de agenda debe ser un entero entre 5 y 120" };
    intervaloAgendaMin = n;
  }

  const horario = validarHorario(t.horario);
  if (!horario) return { ok: false, error: "Horario inválido (usá formato HH:mm, o vacío para día cerrado)" };

  const servicios = validarServicios(t.servicios ?? []);
  if (!servicios) return { ok: false, error: "Hay un servicio inválido (revisá id único, nombre y duración en minutos)" };

  const kb: KnowledgeBase = {
    faq: validarFaq(t.kb?.faq),
    datos: limpiarLineas(t.kb?.datos),
    politicas: limpiarLineas(t.kb?.politicas),
    tarifas: limpiarLineas(t.kb?.tarifas),
    parabrisas: limpiarLineas(t.kb?.parabrisas),
  };

  const usuario = String(body.usuario ?? "").trim();
  if (!RE_USUARIO.test(usuario)) return { ok: false, error: "Usuario inválido (3 a 40 caracteres: letras, números, . _ -)" };
  if (usuario === process.env.PANEL_SUPERADMIN_USUARIO) return { ok: false, error: "Ese usuario está reservado" };
  const password = String(body.password ?? "");
  if (password.length < 8) return { ok: false, error: "La contraseña del panel debe tener al menos 8 caracteres" };

  const tenant: Tenant = { id, nombre, phoneNumberId, accessToken, timezone, moneda, ubicacion, intervaloAgendaMin, horario, servicios, kb };
  return { ok: true, tenant, usuario, password };
}

/** Mapea un choque de índice único de Postgres (23505) a un mensaje claro. */
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

  // ── Fuentes self-hosted (woff2) ──
  if (pathname.startsWith("/panel/fonts/")) {
    const buf = leerFuente(pathname.slice("/panel/fonts/".length));
    if (!buf) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
    res.end(buf);
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

    if (ruta === "admin/tenants" && metodo === "GET") {
      // Resumen liviano: NUNCA exponemos accessToken por la API.
      const tenants = listarTenants().map((t) => ({
        id: t.id,
        nombre: t.nombre,
        phoneNumberId: t.phoneNumberId,
        moneda: t.moneda,
        timezone: t.timezone,
        servicios: t.servicios.length,
      }));
      json(res, 200, { ok: true, tenants });
      return true;
    }

    if (ruta === "admin/tenants" && metodo === "POST") {
      if (!hayBaseDeDatos()) {
        return json(res, 503, { ok: false, error: "El alta de negocios requiere base de datos (no configurada)." }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
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
    if (!cuenta || !ok || !tenant) {
      json(res, 401, { ok: false, error: "Usuario o contraseña incorrectos" });
      return true;
    }
    const cookie = `${COOKIE}=${crearSesion(tenant.id)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
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
  const tenant = tenantDeSesion(req);
  if (!tenant) {
    json(res, 401, { ok: false, error: "No autenticado" });
    return true;
  }

  if (ruta === "me" && metodo === "GET") {
    json(res, 200, { ok: true, nombre: tenant.nombre, tenantId: tenant.id, vapidPublica: clavePublicaVapid() });
    return true;
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
