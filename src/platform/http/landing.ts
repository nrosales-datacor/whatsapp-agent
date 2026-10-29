import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inlineScriptHashes, landingCsp } from "../net/securityHeaders";

// ─────────────────────────────────────────────────────────────────────────────
// Landing pública de venta. Sirve `/`, `/privacidad`, `/terminos`, `/contrato`, los
// assets estáticos bajo `/landing/*`, `/robots.txt` y `/favicon.svg`. Las URLs públicas
// quedan en español: son texto de cara al cliente (y las enlaza el HTML de landing/), no
// rutas de la API. Mismo patrón de caché/allowlist que los estáticos del panel. Devuelve
// true si atendió la request; false para que el servidor siga con sus rutas.
// ─────────────────────────────────────────────────────────────────────────────

const LANDING_DIR = fileURLToPath(new URL("../../../landing/", import.meta.url));
const ASSETS_DIR = path.join(LANDING_DIR, "assets");

// En desarrollo se relee del disco en cada request (para iterar sobre el HTML/CSS).
const IS_DEV = process.env.NODE_ENV !== "production";

const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
};

const pageCache = new Map<string, string>();
const assetCache = new Map<string, Buffer>();

function readPage(name: string): string | null {
  if (!IS_DEV) {
    const cached = pageCache.get(name);
    if (cached !== undefined) return cached;
  }
  try {
    const html = readFileSync(path.join(LANDING_DIR, name), "utf8");
    pageCache.set(name, html);
    return html;
  } catch {
    return null;
  }
}

/** Anti path-traversal: el archivo resuelto debe quedar dentro de landing/assets/. */
function readAsset(file: string): { buf: Buffer; type: string } | null {
  const m = /^[a-zA-Z0-9._-]+\.([a-z0-9]+)$/.exec(file);
  if (!m) return null;
  const type = ASSET_TYPES[m[1]];
  if (!type) return null;

  const resolved = path.join(ASSETS_DIR, file);
  if (!resolved.startsWith(ASSETS_DIR + path.sep) && resolved !== ASSETS_DIR) return null;

  if (!IS_DEV) {
    const cached = assetCache.get(file);
    if (cached) return { buf: cached, type };
  }
  try {
    const buf = readFileSync(resolved);
    assetCache.set(file, buf);
    return { buf, type };
  } catch {
    return null;
  }
}

// CSP de cada página con los hashes de SUS scripts inline: así el script del menú y las
// animaciones de index.html corre sin habilitar 'unsafe-inline'. Se calcula sobre el HTML
// exacto que se sirve (si alguien edita el script, el hash se recalcula solo al recargar
// la página del disco). Cacheado por contenido.
const cspCache = new Map<string, string>();
function pageCsp(html: string): string {
  let csp = cspCache.get(html);
  if (!csp) {
    csp = landingCsp(inlineScriptHashes(html));
    if (cspCache.size > 50) cspCache.clear(); // en dev el HTML se relee en cada request
    cspCache.set(html, csp);
  }
  return csp;
}

function serveHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "content-security-policy": pageCsp(html),
  });
  res.end(html);
}

function methodNotAllowed(res: ServerResponse): true {
  res.writeHead(405);
  res.end("Method not allowed");
  return true;
}

function notFound(res: ServerResponse): true {
  res.writeHead(404);
  res.end("Not found");
  return true;
}

const PAGES: Record<string, string> = {
  "/": "index.html",
  "/privacidad": "privacidad.html",
  "/privacidad.html": "privacidad.html",
  "/terminos": "terminos.html",
  "/terminos.html": "terminos.html",
  // Modelo de contrato B2B + acuerdo de tratamiento de datos.
  "/contrato": "contrato.html",
  "/contrato.html": "contrato.html",
};

export function serveLanding(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const method = req.method ?? "GET";
  const isRead = method === "GET" || method === "HEAD";

  if (pathname === "/robots.txt") {
    if (!isRead) return methodNotAllowed(res);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("User-agent: *\nAllow: /\nDisallow: /panel\n");
    return true;
  }

  if (pathname === "/favicon.svg" || pathname.startsWith("/landing/")) {
    if (!isRead) return methodNotAllowed(res);
    const asset = readAsset(pathname === "/favicon.svg" ? "favicon.svg" : pathname.slice("/landing/".length));
    if (!asset) return notFound(res);
    res.writeHead(200, { "content-type": asset.type, "cache-control": "public, max-age=86400" });
    res.end(asset.buf);
    return true;
  }

  const file = PAGES[pathname];
  if (!file) return false;
  if (!isRead) return methodNotAllowed(res);
  const html = readPage(file);
  if (!html) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Landing no disponible.");
    return true;
  }
  serveHtml(res, html);
  return true;
}
