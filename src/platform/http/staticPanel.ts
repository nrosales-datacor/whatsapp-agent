import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "../email/templates";
import { panelSentryConfig } from "../observability/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Archivos estáticos del panel: build de Vite (web/dist), fuentes self-hosted, PWA
// (service worker, manifest, íconos del build) y fallback SPA para las rutas del cliente.
//
// En desarrollo (NODE_ENV distinto de "production") el index y los archivos de la raíz
// del build se releen en cada request, por si se reconstruyó; igual lo normal en dev es
// el server de Vite (puerto 5173) con HMR, no este build servido por Node.
//
// Al servir el index se le agregan las `<meta name="sentry-*">` con la configuración de
// Sentry del panel (DSN, release, environment) si el server tiene SENTRY_DSN: el panel
// activa su reporte de errores con el `.env` del servidor, sin recompilar (ver
// web/src/lib/errorTracking.ts y panelSentryConfig en observability/sentry.ts).
// ─────────────────────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV !== "production";

// Fuentes self-hosted (woff2 y ttf) en ./fonts (las baja scripts/fetchFonts.mjs). El
// panel las pide en /panel/fonts/* (web/src/global.css). Se cachean en memoria.
const fontCache = new Map<string, Buffer>();
function readFont(file: string): { buf: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(woff2|ttf)$/.test(file)) return null;
  const mime = file.endsWith(".ttf") ? "font/ttf" : "font/woff2";
  const cached = fontCache.get(file);
  if (cached) return { buf: cached, mime };
  try {
    const buf = readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));
    fontCache.set(file, buf);
    return { buf, mime };
  } catch {
    return null;
  }
}

function distPath(rel: string): string {
  return fileURLToPath(new URL(`../../../web/dist/${rel}`, import.meta.url));
}

let cachedIndex: string | null | undefined; // undefined = sin leer; null = no hay build
function readIndex(): string | null {
  if (IS_DEV || cachedIndex === undefined) {
    try {
      cachedIndex = readFileSync(distPath("index.html"), "utf8");
    } catch {
      cachedIndex = null;
    }
  }
  return cachedIndex;
}

/** El index con la configuración de Sentry del panel como `<meta>` (sin DSN, tal cual). */
export function withPanelConfig(index: string, env: Record<string, string | undefined> = process.env): string {
  const sentry = panelSentryConfig(env);
  if (!sentry) return index;
  const metas: [string, string | undefined][] = [
    ["sentry-dsn", sentry.dsn],
    ["sentry-environment", sentry.environment],
    ["sentry-release", sentry.release],
  ];
  const tags = metas
    .filter((m): m is [string, string] => Boolean(m[1]))
    .map(([name, value]) => `<meta name="${name}" content="${escapeHtml(value)}">`)
    .join("");
  const head = index.indexOf("</head>");
  return head === -1 ? index : `${index.slice(0, head)}${tags}${index.slice(head)}`;
}

// Assets hasheados del build (/panel/assets/*). Allowlist estricta (un solo segmento,
// extensión conocida, sin "..") → sin path traversal. Caché en memoria (son inmutables).
const ASSET_TYPES: Record<string, string> = {
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
const assetCache = new Map<string, Buffer>();
function readAsset(file: string): { buf: Buffer; type: string } | null {
  const m = /^([a-zA-Z0-9._-]+)\.([a-z0-9]+)$/.exec(file);
  if (!m || file.includes("..")) return null;
  const type = ASSET_TYPES[m[2]];
  if (!type) return null;
  let buf = assetCache.get(file);
  if (!buf) {
    try {
      buf = readFileSync(distPath(`assets/${file}`));
    } catch {
      return null;
    }
    assetCache.set(file, buf);
  }
  return { buf, type };
}

// Archivos de la RAÍZ del build (no hasheados): sw.js, manifest.webmanifest e íconos. Los
// genera vite-plugin-pwa. Allowlist; en desarrollo no se cachean.
const rootCache = new Map<string, Buffer>();
function readRootFile(rel: string): Buffer | null {
  if (rel !== "sw.js" && rel !== "manifest.webmanifest" && !/^icons\/[a-z0-9-]+\.png$/.test(rel)) {
    return null;
  }
  if (!IS_DEV) {
    const cached = rootCache.get(rel);
    if (cached) return cached;
  }
  try {
    const buf = readFileSync(distPath(rel));
    rootCache.set(rel, buf);
    return buf;
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse): true {
  res.writeHead(404);
  res.end("Not found");
  return true;
}

/**
 * Sirve lo estático del panel: assets hasheados del build, fuentes, PWA (sw/manifest/
 * íconos) y el fallback SPA. true si la request era de acá.
 */
export function serveStaticPanel(res: ServerResponse, pathname: string, method: string): boolean {
  // ── Assets hasheados del build de React (/panel/assets/*) ──
  if (pathname.startsWith("/panel/assets/")) {
    const asset = readAsset(pathname.slice("/panel/assets/".length));
    if (!asset) return notFound(res);
    res.writeHead(200, { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable" });
    res.end(asset.buf);
    return true;
  }

  // ── Fuentes self-hosted (woff2 y ttf) ──
  if (pathname.startsWith("/panel/fonts/")) {
    const font = readFont(pathname.slice("/panel/fonts/".length));
    if (!font) return notFound(res);
    res.writeHead(200, { "content-type": font.mime, "cache-control": "public, max-age=31536000, immutable" });
    res.end(font.buf);
    return true;
  }

  // ── Assets de la PWA: service worker, manifest e íconos (del build) ──
  if (pathname === "/panel/sw.js" || pathname === "/panel/manifest.webmanifest" || pathname.startsWith("/panel/icons/")) {
    const rel = pathname.slice("/panel/".length);
    const buf = readRootFile(rel);
    if (!buf) return notFound(res);
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
  // Cualquier /panel/* de PÁGINA (no asset) sirve el index del build, para que el
  // deep-link a una ruta cliente (p. ej. /panel/admin) funcione en carga completa. Va
  // DESPUÉS de los bloques de assets (que ya hacen return), así no los sombrea.
  if (pathname === "/panel" || pathname.startsWith("/panel/")) {
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    }
    const index = readIndex();
    if (!index) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Panel no disponible — corré `npm run web:build` y reiniciá el proceso.");
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(withPanelConfig(index));
    return true;
  }
  return false;
}
