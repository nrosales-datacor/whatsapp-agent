// ─────────────────────────────────────────────────────────────────────────────
// URL pública de la app, para los links que salen por correo (invitación, recuperación de
// clave, y más adelante confirmar o cancelar una cita).
//
// Sale SIEMPRE de la env `PUBLIC_BASE_URL`, nunca del header `Host` del request: con el
// Host, un atacante pide "recuperar la clave de ana@…" mandando `Host: evil.com` y a Ana
// le llega un link legítimo, con un token válido, que apunta al sitio del atacante.
//
// Sin la env: en desarrollo, `http://localhost:<PORT>`; en producción, error (un correo
// con un link a localhost es peor que un error visible; el server avisa al arrancar).
// ─────────────────────────────────────────────────────────────────────────────

/** Base pública sin barra final, p. ej. "https://app.selyon.app". Lanza en producción si falta. */
export function publicBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PUBLIC_BASE_URL no está configurada: no se pueden armar los links de los correos.");
    }
    return `http://localhost:${process.env.PORT ?? 3000}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL no es una URL válida.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PUBLIC_BASE_URL debe ser http(s).");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** URL absoluta de una ruta de la app (`"/panel/reset-password"`) con su query. */
export function publicUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${publicBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
