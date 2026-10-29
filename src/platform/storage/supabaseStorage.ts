import { STORAGE_TIMEOUT_MS, timeoutSignal } from "../net/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Archivos en Supabase Storage vía REST — sin SDK nuevo (`@supabase/supabase-js`):
// fetch con timeout y credenciales por env.
//
// POR QUÉ: los binarios (fotos que manda un cliente, adjuntos, logos) no van en Postgres.
// Guardarlos como data URL base64 en una columna infla tabla, backups y la RAM de quien
// la lee (una foto de 4 MB ≈ 5,4 MB por fila). Acá el binario va a un bucket PRIVADO y en
// la base solo queda la RUTA del objeto (un string corto); quien lo muestra pide una URL
// FIRMADA de corta vida recién al necesitarla.
//
// Las rutas empiezan SIEMPRE por el id del negocio (`objectPath(tenantId, …)`): así
// "borrar todo lo de un negocio" es borrar ese prefijo y nunca se cruzan archivos entre
// negocios.
//
// CÓMO CONFIGURARLO (una sola vez):
//   1. Supabase Dashboard → Project Settings → API: "Project URL" (SUPABASE_URL) y la
//      key "service_role" (SUPABASE_SERVICE_ROLE_KEY, NO la "anon" — esa no tiene permiso
//      de escritura sobre un bucket privado).
//   2. Storage → creá un bucket PRIVADO (default "media"; otro con SUPABASE_STORAGE_BUCKET).
//
// Sin credenciales, `storageConfigured()` es false: subir lanza y firmar devuelve null.
// Qué hacer en ese caso (fallar, guardar en otro lado, avisar) lo decide cada módulo.
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "media";

// 5 minutos de vida para la URL firmada: sobra para que el navegador descargue el
// archivo; se re-firma (con caché, ver abajo) en cada lectura.
const SIGNED_URL_TTL_SEC = 300;

/** ¿Está Supabase Storage configurado? */
export function storageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Headers de autenticación del service role: Storage exige AMBOS, no solo Authorization. */
function authHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return { Authorization: `Bearer ${key}`, apikey: key };
}

// Un prefijo vacío o con ".." borraría el bucket entero (o algo fuera del negocio): solo
// se aceptan segmentos con caracteres seguros.
const SAFE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

function assertSafePath(p: string): void {
  if (!SAFE_PATH.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Error(`Ruta de Storage inválida: "${p}"`);
  }
}

/**
 * Ruta determinística de un objeto: `{tenantId}/{...segmentos}`. Cada segmento se sanea
 * (lo que no es [A-Za-z0-9_.-] pasa a "_"), así un id externo (p. ej. el de un mensaje de
 * WhatsApp) no puede escaparse del prefijo del negocio. Reintentos con los mismos
 * segmentos pisan el mismo objeto (subida idempotente) en vez de acumular basura.
 */
export function objectPath(tenantId: string, ...segments: string[]): string {
  const clean = [tenantId, ...segments].map((s) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, "_"));
  const p = clean.join("/");
  assertSafePath(p);
  return p;
}

/**
 * Sube un binario al bucket privado y devuelve su RUTA (no una URL: el bucket es privado).
 * Lanza si Storage no está configurado o si la subida falla — el llamador decide qué hacer.
 */
export async function uploadObject(path: string, body: Buffer, contentType: string): Promise<string> {
  if (!storageConfigured()) throw new Error("Supabase Storage no configurado (faltan env vars)");
  assertSafePath(path);
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": contentType || "application/octet-stream",
      // Reintentos con la misma ruta no deben fallar por "ya existe".
      "x-upsert": "true",
    },
    // `fetch` tipa el body binario como Uint8Array, no como Buffer (aunque Buffer extienda
    // Uint8Array en runtime) — copia explícita para conformar el tipo.
    body: new Uint8Array(body),
    signal: timeoutSignal(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase Storage subir (${res.status}): ${detail.slice(0, 200)}`);
  }
  return path;
}

/**
 * Firma una URL de corta vida para un objeto ya subido. Devuelve `null` (no lanza) si
 * Storage no está configurado o si la firma falla — una pantalla debe poder mostrarse
 * aunque un archivo puntual no se pueda firmar.
 */
export async function signObjectUrl(path: string, expiresInSec: number = SIGNED_URL_TTL_SEC): Promise<string | null> {
  if (!storageConfigured()) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: expiresInSec }),
      signal: timeoutSignal(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[storage] no se pudo firmar la URL de "${path}" (${res.status})`);
      return null;
    }
    const { signedURL } = (await res.json()) as { signedURL: string };
    // Supabase devuelve una ruta relativa a /storage/v1 (ej: "/object/sign/bucket/ruta?token=…").
    return `${process.env.SUPABASE_URL}/storage/v1${signedURL}`;
  } catch (e) {
    console.error(`[storage] error firmando URL de "${path}":`, e);
    return null;
  }
}

// Caché de URLs firmadas. Una pantalla que se refresca cada pocos segundos (p. ej. un
// chat) firmaría de nuevo TODOS sus archivos (una llamada a Storage por archivo) y, como
// la URL cambia, el navegador los volvería a descargar. Se reusa la misma URL hasta que le
// quede menos de CACHE_MARGIN_MS de vida. Acotado en tamaño (se descarta lo más viejo).
const signedUrls = new Map<string, { url: string; expiresAt: number }>();
const MAX_CACHED_URLS = 5000;
const CACHE_MARGIN_MS = 60_000;

function cacheUrl(path: string, url: string): void {
  signedUrls.delete(path); // reinsertar = queda como la más nueva
  signedUrls.set(path, { url, expiresAt: Date.now() + SIGNED_URL_TTL_SEC * 1000 });
  while (signedUrls.size > MAX_CACHED_URLS) {
    const oldest = signedUrls.keys().next().value;
    if (oldest === undefined) break;
    signedUrls.delete(oldest);
  }
}

/** Saca del caché las URLs de objetos borrados. */
function forgetUrls(prefix: string): void {
  for (const p of signedUrls.keys()) if (p === prefix || p.startsWith(`${prefix}/`)) signedUrls.delete(p);
}

/**
 * URL firmada para mostrar un objeto, reusando la del caché mientras le quede vida.
 * `undefined` si no hay ruta o si no se pudo firmar (Storage caído, mal configurado o el
 * objeto ya no existe): el resto de la pantalla se sigue mostrando.
 */
export async function cachedSignedUrl(path: string | null | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const cached = signedUrls.get(path);
  if (cached && cached.expiresAt - Date.now() > CACHE_MARGIN_MS) return cached.url;
  const signed = await signObjectUrl(path);
  if (!signed) return undefined;
  cacheUrl(path, signed);
  return signed;
}

/** Solo para tests. */
export function _resetSignedUrlCacheForTests(): void {
  signedUrls.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrado: derecho de supresión de un cliente final (Ley 8968) y baja completa de un
// negocio. Como las rutas empiezan por el negocio (`objectPath`), "borrar todo lo de un
// negocio" es borrar el prefijo `{tenantId}`. A diferencia de firmar, acá un error de
// Storage LANZA: el llamador decide si aborta (para poder reintentar) o si lo registra y
// sigue.
// ─────────────────────────────────────────────────────────────────────────────

const LIST_PAGE = 1000;
const DELETE_BATCH = 100;

/**
 * Rutas completas de los objetos bajo `prefix` (recorre subcarpetas hasta `depth`
 * niveles). Lanza si Storage responde con error.
 */
async function listPaths(prefix: string, depth: number): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } }),
      signal: timeoutSignal(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Supabase Storage listar (${res.status}): ${detail.slice(0, 200)}`);
    }
    const page = (await res.json()) as { name: string; id: string | null }[];
    for (const item of page) {
      if (!item?.name) continue;
      const p = `${prefix}/${item.name}`;
      // Las "carpetas" vienen con id null: se recorren (con tope de profundidad).
      if (item.id === null) {
        if (depth > 0) paths.push(...(await listPaths(p, depth - 1)));
      } else {
        paths.push(p);
      }
    }
    if (page.length < LIST_PAGE) break;
  }
  return paths;
}

/** Borra objetos puntuales por ruta (en lotes). Lanza si Storage responde con error. */
export async function deleteObjects(paths: string[]): Promise<number> {
  if (!storageConfigured() || paths.length === 0) return 0;
  for (const p of paths) assertSafePath(p);
  let deleted = 0;
  for (let i = 0; i < paths.length; i += DELETE_BATCH) {
    const batch = paths.slice(i, i + DELETE_BATCH);
    const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: batch }),
      signal: timeoutSignal(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Supabase Storage borrar (${res.status}): ${detail.slice(0, 200)}`);
    }
    deleted += batch.length;
    for (const p of batch) forgetUrls(p);
  }
  return deleted;
}

/**
 * Borra TODOS los objetos bajo `prefix` (ej. `"<tenantId>"` o `"<tenantId>/<carpeta>"`).
 * Devuelve `{ configured: false }` sin hacer nada si Storage no está configurado. Lanza si
 * Storage responde con error, o si el prefijo no es seguro.
 */
export async function deletePrefix(prefix: string, depth = 3): Promise<{ configured: boolean; deleted: number }> {
  assertSafePath(prefix);
  if (!storageConfigured()) return { configured: false, deleted: 0 };
  const paths = await listPaths(prefix, depth);
  const deleted = await deleteObjects(paths);
  forgetUrls(prefix);
  return { configured: true, deleted };
}
