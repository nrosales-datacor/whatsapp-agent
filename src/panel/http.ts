import type { IncomingMessage, ServerResponse } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers HTTP del panel: respuestas JSON, cookies, cuerpo con tope y guard CSRF.
// ─────────────────────────────────────────────────────────────────────────────

export const COOKIE = "panel_sesion";
export const COOKIE_ADMIN = "panel_admin_sesion"; // sesión del superadmin (onboarding), aparte de la del operador

export function json(res: ServerResponse, status: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// 429 del rate limit de login (E6/BLOQUEANTE-10). Mismo mensaje/forma sin importar si
// el límite que se pasó fue el de IP o el de usuario — no hay que darle a quien está
// mirando la respuesta ninguna pista de CUÁL de los dos disparó el corte.
export function json429RateLimit(res: ServerResponse, retryAfterSeg: number) {
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(retryAfterSeg),
  });
  res.end(JSON.stringify({ ok: false, error: "Demasiados intentos. Probá de nuevo en unos minutos." }));
}

export function leerCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const par of raw.split(";")) {
    const i = par.indexOf("=");
    if (i === -1) continue;
    // `decodeURIComponent` LANZA con secuencias inválidas (`%`, `%zz`): una cookie
    // malformada, sin autenticarse, no puede tumbar el request (ni el proceso).
    try {
      out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
    } catch {
      // cookie ilegible → se ignora, como si no viniera
    }
  }
  return out;
}

export const MAX_BODY = 64 * 1024; // 64 KB: los cuerpos del panel son chicos (texto/notas/login)
/** Lee el cuerpo JSON con tope de tamaño. Devuelve null si excede el límite. */
export async function leerBody(req: IncomingMessage): Promise<any | null> {
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
export function mismoOrigen(req: IncomingMessage): boolean {
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
