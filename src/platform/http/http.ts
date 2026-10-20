import type { IncomingMessage, ServerResponse } from "node:http";
import { readBodyWithLimit } from "../net/http";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers HTTP de la API del panel (/api/panel/*): respuestas JSON, cookies, cuerpo con
// tope y guard CSRF por mismo origen.
// ─────────────────────────────────────────────────────────────────────────────

/** Cookie de la sesión del equipo del negocio. */
export const SESSION_COOKIE = "panel_session";
/** Cookie de la sesión del superadmin, aparte de la del equipo. */
export const ADMIN_SESSION_COOKIE = "panel_admin_session";

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export interface CookieOptions {
  /** Segundos de vida; 0 borra la cookie. */
  maxAgeSec: number;
  /** `Lax` (sesión del equipo: los links de los correos llegan con la sesión) o `Strict` (superadmin). */
  sameSite: "Lax" | "Strict";
}

/**
 * Cabecera `Set-Cookie` de una cookie de sesión: siempre `HttpOnly` (el JS del panel no
 * la ve), `Path=/` y `SameSite`; `Secure` en producción (en desarrollo el panel corre por
 * http://localhost y una cookie Secure no volvería por http). El valor es un token
 * base64url: no lleva caracteres que haya que escapar.
 */
export function sessionCookie(name: string, value: string, options: CookieOptions): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = Math.max(0, Math.floor(options.maxAgeSec));
  return `${name}=${value}; HttpOnly; SameSite=${options.sameSite}; Path=/; Max-Age=${maxAge}${secure}`;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const i = pair.indexOf("=");
    if (i === -1) continue;
    // `decodeURIComponent` LANZA con secuencias inválidas (`%`, `%zz`): una cookie
    // malformada, sin autenticarse, no puede tumbar el request (ni el proceso).
    try {
      out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    } catch {
      // cookie ilegible → se ignora, como si no viniera
    }
  }
  return out;
}

export const MAX_JSON_BODY = 64 * 1024; // 64 KB: los cuerpos del panel son chicos (formularios, notas, login)

/**
 * Lee el cuerpo JSON con tope de tamaño. Devuelve null si excede el límite (el llamador
 * responde 413) y `{}` si viene vacío o no es JSON válido.
 */
export async function readJsonBody(req: IncomingMessage, max = MAX_JSON_BODY): Promise<unknown | null> {
  const body = await readBodyWithLimit(req, max);
  if (body === null) return null;
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}

/** Acepta el request solo si el Origin/Referer coincide con el host (anti-CSRF). */
export function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return false; // un POST que cambia estado sin Origin/Referer → rechazar
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
