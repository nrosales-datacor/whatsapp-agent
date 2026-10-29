import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpHandler } from "./http";

// ─────────────────────────────────────────────────────────────────────────────
// Cabeceras de seguridad HTTP. Sin ellas el panel se podía meter en un <iframe> ajeno
// (clickjacking), no había CSP que frenara un XSS, ni HSTS, ni nosniff.
//
// Un solo helper para TODO lo que sirve el proceso (panel, API, landing, /health,
// webhooks): `withSecurityHeaders` envuelve el handler HTTP de server.ts y fija, con
// `res.setHeader`, las cabeceras comunes + una CSP según la ruta ANTES de que cada módulo
// haga su `writeHead` (que las conserva: Node mezcla lo de setHeader con lo de writeHead,
// y si un módulo pasa la misma cabecera, gana la suya — así la landing pone su CSP con
// los hashes de sus scripts inline, ver src/platform/http/landing.ts).
//
// CSP por ruta:
//   • /panel/* (SPA de React, build de Vite): sin scripts ni estilos inline (el build no
//     los usa: index.html solo referencia /panel/assets/*), fuentes self-hosted, SW y
//     manifest propios. `connect-src 'self'`: el panel solo habla con /api/panel/*.
//     `img-src 'self' data: blob: https:` — data: por los íconos inline del CSS, https:
//     por las URLs firmadas de Supabase Storage y el logo de marca de cada negocio.
//     `media-src 'self' blob: https:` — las notas de voz de la bandeja se reproducen desde
//     URLs firmadas de Supabase Storage.
//   • /panel/admin* y /panel/whatsapp/settings*: lo mismo + el SDK de Facebook del
//     Embedded Signup (módulo WhatsApp, lo usan el superadmin y la configuración del número
//     del negocio): script de connect.facebook.net, iframes/llamadas a *.facebook.com,
//     estilos inline que inyecta el SDK y COOP que permite el popup de Meta. La CSP es la
//     del documento que se CARGÓ: el panel tiene que abrir esas rutas con una carga
//     completa (no solo navegación interna de la SPA) para que el SDK quede permitido.
//   • Landing (/, /privacidad, …): HTML estático, sin nada externo.
//   • API JSON, /health, /webhook/*: no son documentos → `default-src 'none'`.
// ─────────────────────────────────────────────────────────────────────────────

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function joinDirectives(directives: Record<string, string>): string {
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

/** CSP del panel (SPA). `admin` suma lo que necesita el SDK de Facebook (Embedded Signup). */
export function panelCsp(admin = false): string {
  return joinDirectives({
    "default-src": "'self'",
    "script-src": admin ? "'self' https://connect.facebook.net" : "'self'",
    "style-src": admin ? "'self' 'unsafe-inline'" : "'self'",
    "img-src": "'self' data: blob: https:",
    "media-src": "'self' blob: https:",
    "font-src": "'self'",
    "connect-src": admin ? "'self' https://*.facebook.com https://graph.facebook.com" : "'self'",
    "frame-src": admin ? "https://*.facebook.com" : "'none'",
    "worker-src": "'self'",
    "manifest-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
    "frame-ancestors": "'none'",
  });
}

/** CSP de la landing. `scriptHashes` = hashes CSP ('sha256-…') de sus <script> inline. */
export function landingCsp(scriptHashes: string[] = []): string {
  return joinDirectives({
    "default-src": "'self'",
    "script-src": ["'self'", ...scriptHashes].join(" "),
    "style-src": "'self'",
    "img-src": "'self' data:",
    "font-src": "'self'",
    "connect-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
    "frame-ancestors": "'none'",
  });
}

/** Hashes CSP ('sha256-<base64>') de cada <script> inline (sin src) de un HTML. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    if (/\ssrc\s*=/i.test(m[1] ?? "")) continue;
    // El parser HTML normaliza CRLF/CR a LF ANTES de tokenizar, y el navegador hashea el
    // script ya normalizado. Sin esto, un landing/*.html con fin de línea CRLF (checkout
    // en Windows con core.autocrlf) produce un hash distinto y la CSP bloquea el script.
    const content = m[2].replace(/\r\n?/g, "\n");
    out.push(`'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`);
  }
  return out;
}

function isPanelPath(pathname: string): boolean {
  return pathname === "/panel" || pathname.startsWith("/panel/");
}

/** Rutas del panel que cargan el SDK de Facebook (Embedded Signup): superadmin y configuración del número. */
function isMetaSdkPath(pathname: string): boolean {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  return under("/panel/admin") || under("/panel/whatsapp/settings");
}

function isNonDocument(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/health" || pathname === "/webhook" || pathname.startsWith("/webhook/");
}

/**
 * ¿Llegó por https? Socket TLS directo, o `X-Forwarded-Proto: https` del proxy (Caddy /
 * nginx terminan TLS). Ese header lo podría falsear el propio cliente, pero solo cambia
 * SU respuesta (agregar HSTS de más no le sirve de nada a un atacante). `SECURITY_HSTS`
 * fuerza: "1" = siempre, "0" = nunca (p. ej. si el dominio todavía no tiene https estable).
 */
function cameOverHttps(req: IncomingMessage): boolean {
  const forced = process.env.SECURITY_HSTS?.trim();
  if (forced === "0") return false;
  if (forced === "1") return true;
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
  const xfp = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(xfp) ? xfp[0] : xfp)?.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

/** Fija las cabeceras de seguridad de esta respuesta según la ruta (ver cabecera del módulo). */
export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY"); // navegadores viejos sin frame-ancestors
  res.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  );
  if (cameOverHttps(req)) {
    // 1 año, SIN includeSubDomains: otros subdominios del dominio (selyon.app) no son de
    // este proceso y no hay por qué imponerles https desde acá.
    res.setHeader("strict-transport-security", "max-age=31536000");
  }

  if (isPanelPath(pathname)) {
    const admin = isMetaSdkPath(pathname);
    res.setHeader("content-security-policy", panelCsp(admin));
    // El popup de Meta (Embedded Signup) necesita conservar window.opener.
    res.setHeader("cross-origin-opener-policy", admin ? "same-origin-allow-popups" : "same-origin");
  } else if (isNonDocument(pathname)) {
    res.setHeader("content-security-policy", API_CSP);
  } else {
    // Landing y cualquier otra ruta (404s incluidos). Las páginas HTML de la landing
    // reemplazan esta CSP por una con los hashes de sus scripts inline.
    res.setHeader("content-security-policy", landingCsp());
    res.setHeader("cross-origin-opener-policy", "same-origin");
  }
}

/** Envuelve un handler HTTP para que TODAS sus respuestas salgan con las cabeceras de seguridad. */
export function withSecurityHeaders(handler: HttpHandler): HttpHandler {
  return async (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      // URL ilegible: se aplica el perfil por defecto (landing)
    }
    applySecurityHeaders(req, res, pathname);
    await handler(req, res);
  };
}
