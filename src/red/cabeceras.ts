import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HandlerHttp } from "./http";

// ─────────────────────────────────────────────────────────────────────────────
// Cabeceras de seguridad HTTP (revisión de seguridad pre-venta 2026-10). Antes ninguna
// respuesta las tenía: el panel se podía meter en un <iframe> ajeno (clickjacking), no
// había CSP que frenara un XSS, ni HSTS, ni nosniff.
//
// Un solo helper para TODO lo que sirve el proceso (panel, API, landing, /salud,
// webhook): `conCabecerasSeguridad` envuelve el handler HTTP de server.ts y fija, con
// `res.setHeader`, las cabeceras comunes + una CSP según la ruta ANTES de que cada
// módulo haga su `writeHead` (que las conserva: Node mezcla lo de setHeader con lo de
// writeHead, y si un módulo pasa la misma cabecera, gana la suya — así la landing pone
// su CSP con los hashes de sus scripts inline, ver src/landing/servirLanding.ts).
//
// CSP por ruta:
//   • /panel/* (SPA de React, build de Vite): sin scripts ni estilos inline (el build no
//     los usa: index.html solo referencia /panel/assets/*), fuentes self-hosted, SW y
//     manifest propios. `connect-src 'self'`: el panel solo habla con /api/panel/*.
//     `img-src 'self' data: blob: https:` — data: por el favicon/íconos inline del CSS,
//     https: por las fotos de los chats (URLs firmadas de Supabase Storage) y el logo
//     white-label de cada negocio (ver validarLogoUrl: solo https).
//   • /panel/admin*: lo mismo + el SDK de Facebook del Embedded Signup (C4.2):
//     script de connect.facebook.net, iframes/llamadas a *.facebook.com, estilos inline
//     que inyecta el SDK y COOP que permite el popup de Meta.
//   • Landing (/, /privacidad, …): HTML estático, sin nada externo.
//   • API JSON, /salud, /webhook: no son documentos → `default-src 'none'`.
// ─────────────────────────────────────────────────────────────────────────────

const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function unir(directivas: Record<string, string>): string {
  return Object.entries(directivas)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

/** CSP del panel (SPA). `admin` suma lo que necesita el SDK de Facebook (Embedded Signup). */
export function cspPanel(admin = false): string {
  return unir({
    "default-src": "'self'",
    "script-src": admin ? "'self' https://connect.facebook.net" : "'self'",
    "style-src": admin ? "'self' 'unsafe-inline'" : "'self'",
    "img-src": "'self' data: blob: https:",
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

/** CSP de la landing. `hashesScript` = hashes CSP ('sha256-…') de sus <script> inline. */
export function cspLanding(hashesScript: string[] = []): string {
  return unir({
    "default-src": "'self'",
    "script-src": ["'self'", ...hashesScript].join(" "),
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
export function hashesScriptsInline(html: string): string[] {
  const out: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    if (/\ssrc\s*=/i.test(m[1] ?? "")) continue;
    out.push(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return out;
}

function esRutaPanel(pathname: string): boolean {
  return pathname === "/panel" || pathname.startsWith("/panel/");
}

function esRutaAdmin(pathname: string): boolean {
  return pathname === "/panel/admin" || pathname.startsWith("/panel/admin/");
}

function esNoDocumento(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/salud" || pathname === "/webhook";
}

/**
 * ¿Llegó por https? Socket TLS directo, o `X-Forwarded-Proto: https` del proxy (Caddy /
 * nginx terminan TLS). Ese header lo podría falsear el propio cliente, pero solo cambia
 * SU respuesta (agregar HSTS de más no le sirve de nada a un atacante). `SEGURIDAD_HSTS`
 * fuerza: "1" = siempre, "0" = nunca (p. ej. si el dominio todavía no tiene https estable).
 */
function vinoPorHttps(req: IncomingMessage): boolean {
  const forzado = process.env.SEGURIDAD_HSTS?.trim();
  if (forzado === "0") return false;
  if (forzado === "1") return true;
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
  const xfp = req.headers["x-forwarded-proto"];
  const primero = (Array.isArray(xfp) ? xfp[0] : xfp)?.split(",")[0]?.trim().toLowerCase();
  return primero === "https";
}

/** Fija las cabeceras de seguridad de esta respuesta según la ruta (ver cabecera del módulo). */
export function aplicarCabecerasSeguridad(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY"); // navegadores viejos sin frame-ancestors
  res.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  );
  if (vinoPorHttps(req)) {
    // 1 año, SIN includeSubDomains: otros subdominios del dominio (selyon.app) no son de
    // este proceso y no hay por qué imponerles https desde acá.
    res.setHeader("strict-transport-security", "max-age=31536000");
  }

  if (esRutaPanel(pathname)) {
    const admin = esRutaAdmin(pathname);
    res.setHeader("content-security-policy", cspPanel(admin));
    // El popup de Meta (Embedded Signup) necesita conservar window.opener.
    res.setHeader("cross-origin-opener-policy", admin ? "same-origin-allow-popups" : "same-origin");
  } else if (esNoDocumento(pathname)) {
    res.setHeader("content-security-policy", CSP_API);
  } else {
    // Landing y cualquier otra ruta (404s incluidos). Las páginas HTML de la landing
    // reemplazan esta CSP por una con los hashes de sus scripts inline.
    res.setHeader("content-security-policy", cspLanding());
    res.setHeader("cross-origin-opener-policy", "same-origin");
  }
}

/** Envuelve un handler HTTP para que TODAS sus respuestas salgan con las cabeceras de seguridad. */
export function conCabecerasSeguridad(handler: HandlerHttp): HandlerHttp {
  return async (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      // URL ilegible: se aplica el perfil por defecto (landing)
    }
    aplicarCabecerasSeguridad(req, res, pathname);
    await handler(req, res);
  };
}
