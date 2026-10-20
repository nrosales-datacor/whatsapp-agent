import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Archivos estáticos del panel (build de Vite en web/dist, fuentes, PWA) y fallback SPA.
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Sirve lo estático del panel: assets hasheados del build, fuentes, PWA (sw/manifest/
 * íconos) y el fallback SPA. true si la request era de acá.
 */
export function servirEstaticosPanel(res: ServerResponse, pathname: string, metodo: string): boolean {
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
  return false;
}
