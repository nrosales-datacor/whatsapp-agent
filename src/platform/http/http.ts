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

/**
 * 429 del rate limit de login. Mismo mensaje/forma sin importar si el límite que se pasó
 * fue el de IP o el de usuario — no hay que darle a quien mira la respuesta ninguna pista
 * de CUÁL de los dos disparó el corte.
 */
export function sendRateLimited(res: ServerResponse, retryAfterSec: number): void {
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(retryAfterSec),
  });
  res.end(JSON.stringify({ ok: false, error: "Demasiados intentos. Probá de nuevo en unos minutos." }));
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
