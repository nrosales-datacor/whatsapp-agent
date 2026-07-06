import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Landing pública de venta (ROADMAP C4.4). Sirve `/`, `/privacidad`, `/terminos`,
// los assets estáticos bajo `/landing/*`, `/robots.txt` y `/favicon.svg`.
// Mismo patrón de caché/allowlist que los estáticos del panel (src/panel/router.ts).
// Devuelve true si atendió la request; false para que server.ts siga con sus rutas.
// ─────────────────────────────────────────────────────────────────────────────

const DIR_LANDING = fileURLToPath(new URL("../../landing/", import.meta.url));
const DIR_ASSETS = path.join(DIR_LANDING, "assets");

const TIPOS_ASSET: Record<string, string> = {
  css: "text/css; charset=utf-8",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
};

const paginaCache = new Map<string, string>();
const assetCache = new Map<string, Buffer>();

function leerPagina(nombre: string): string | null {
  if (!process.env.SEED_DEMO) {
    const cached = paginaCache.get(nombre);
    if (cached !== undefined) return cached;
  }
  try {
    const html = readFileSync(path.join(DIR_LANDING, nombre), "utf8");
    paginaCache.set(nombre, html);
    return html;
  } catch {
    return null;
  }
}

/** Anti path-traversal: el archivo resuelto debe quedar dentro de landing/assets/. */
function leerAsset(archivo: string): { buf: Buffer; tipo: string } | null {
  const m = /^[a-zA-Z0-9._-]+\.([a-z0-9]+)$/.exec(archivo);
  if (!m) return null;
  const tipo = TIPOS_ASSET[m[1]];
  if (!tipo) return null;

  const ruta = path.join(DIR_ASSETS, archivo);
  if (!ruta.startsWith(DIR_ASSETS + path.sep) && ruta !== DIR_ASSETS) return null;

  if (!process.env.SEED_DEMO) {
    const cached = assetCache.get(archivo);
    if (cached) return { buf: cached, tipo };
  }
  try {
    const buf = readFileSync(ruta);
    assetCache.set(archivo, buf);
    return { buf, tipo };
  } catch {
    return null;
  }
}

function servirHtml(res: ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(html);
}

export function manejarLanding(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const metodo = req.method ?? "GET";

  if (pathname === "/robots.txt") {
    if (metodo !== "GET" && metodo !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("User-agent: *\nAllow: /\nDisallow: /panel\n");
    return true;
  }

  if (pathname === "/favicon.svg") {
    if (metodo !== "GET" && metodo !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    }
    const asset = leerAsset("favicon.svg");
    if (!asset) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    res.writeHead(200, { "content-type": asset.tipo, "cache-control": "public, max-age=86400" });
    res.end(asset.buf);
    return true;
  }

  if (pathname.startsWith("/landing/")) {
    if (metodo !== "GET" && metodo !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    }
    const asset = leerAsset(pathname.slice("/landing/".length));
    if (!asset) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    res.writeHead(200, { "content-type": asset.tipo, "cache-control": "public, max-age=86400" });
    res.end(asset.buf);
    return true;
  }

  const PAGINAS: Record<string, string> = {
    "/": "index.html",
    "/privacidad": "privacidad.html",
    "/privacidad.html": "privacidad.html",
    "/terminos": "terminos.html",
    "/terminos.html": "terminos.html",
  };
  const archivo = PAGINAS[pathname];
  if (!archivo) return false;

  if (metodo !== "GET" && metodo !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return true;
  }
  const html = leerPagina(archivo);
  if (!html) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Landing no disponible.");
    return true;
  }
  servirHtml(res, html);
  return true;
}
