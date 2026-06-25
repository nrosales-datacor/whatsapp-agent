import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TENANTS } from "../config/tenants";
import { enviarTexto } from "../whatsapp/client";
import type { Repositorio, Tenant } from "../types";
import { crearSesion, HASH_DUMMY, verificarPassword, verificarSesion } from "./auth";
import { clavePublicaVapid, enviarPushATenant } from "./push";

// ─────────────────────────────────────────────────────────────────────────────
// Panel web (bandeja humana). Maneja las rutas /panel, /panel/* y /api/panel/*.
// Devuelve true si manejó la request; false si no es ruta del panel.
// ─────────────────────────────────────────────────────────────────────────────

const COOKIE = "panel_sesion";
const HTML = readFileSync(fileURLToPath(new URL("./inbox.html", import.meta.url)), "utf8");

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
// Build de React (Vite) del panel nuevo (web/dist). Si existe se sirve ese; si no,
// se cae al inbox.html actual — así el panel nunca queda en blanco mientras dura la
// migración (ROADMAP carril A) o si todavía no se corrió `npm run build` en web/.
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
  return TENANTS.find((t) => t.id === tid) ?? null;
}

export async function manejarPanel(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repositorio,
  pathname: string,
): Promise<boolean> {
  const metodo = req.method ?? "GET";

  // ── La página del panel ──
  // Preferimos el build de React (web/dist); si no existe, servimos el inbox.html
  // actual como fallback (migración incremental — ver ROADMAP carril A).
  if (pathname === "/panel" || pathname === "/panel/") {
    const react = leerReactIndex();
    if (react) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(react);
      return true;
    }
    // Fallback: panel actual (vanilla). En dev (SEED_DEMO) se relee para iterar.
    const html = process.env.SEED_DEMO
      ? readFileSync(fileURLToPath(new URL("./inbox.html", import.meta.url)), "utf8")
      : HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

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
  if (pathname === "/panel/sw.js" || pathname === "/panel/manifest.webmanifest" || pathname.startsWith("/panel/icons/")) {
    const rel = pathname.slice("/panel/".length);
    const buf = leerAsset(rel);
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

  if (!pathname.startsWith("/api/panel/")) return false;
  const ruta = pathname.slice("/api/panel/".length).replace(/\/$/, "");

  // CSRF: todo POST del panel cambia estado y debe venir del mismo origen.
  if (metodo === "POST" && !mismoOrigen(req)) {
    json(res, 403, { ok: false, error: "Origen no permitido" });
    return true;
  }

  // ── Login ──
  if (ruta === "login" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const { usuario, password } = body;
    const tenant = TENANTS.find((t) => t.id === usuario);
    // Corremos scrypt SIEMPRE (con un hash dummy si el usuario no existe) para no
    // filtrar por timing qué tenants son válidos. El 401 es idéntico en ambos casos.
    const ok = verificarPassword(String(password ?? ""), tenant?.panelPasswordHash ?? HASH_DUMMY);
    if (!tenant || !ok) {
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
