import { conTimeout, TIMEOUT_STORAGE_MS } from "../red/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Integración con Supabase Storage vía REST (Carril F, F9) — sin SDK nuevo
// (`@supabase/supabase-js`), mismo estilo que `calendar/googleCalendar.ts`: fetch
// con timeout, credenciales por env, fail-SOFT si no están configuradas.
//
// POR QUÉ: hoy la foto que manda un cliente por WhatsApp se guarda como data URL
// base64 COMPLETA en `wa_mensajes.media_url` (texto): una foto de 4 MB ≈ 5,4 MB
// por fila. A 50 tenants con chats de varias fotos, eso infla tabla, backups y la
// RAM del panel (que trae hasta 100 mensajes por conversación). Acá el binario va
// a un bucket privado de Supabase Storage y en la columna solo queda la RUTA del
// objeto (un string corto); el panel pide una URL FIRMADA de corta vida recién al
// mostrar el chat.
//
// CÓMO CONFIGURARLO (una sola vez):
//   1. Supabase Dashboard → Project Settings → API: copiá "Project URL"
//      (SUPABASE_URL) y la "service_role" key (SUPABASE_SERVICE_ROLE_KEY, NO la
//      "anon" — esta última no tiene permiso de escritura sobre un bucket privado).
//   2. Storage → creá un bucket PRIVADO (nombre por default: "wa-fotos", ver
//      SUPABASE_STORAGE_BUCKET más abajo si preferís otro).
//
// FAIL-SOFT A PROPÓSITO (a diferencia de F2/F5, que son fail-CLOSED): ahí el
// riesgo de arrancar sin la env era de SEGURIDAD (token en claro / negocio mudo).
// Acá el riesgo de no tenerla es solo tamaño de tabla — una optimización, no una
// falla de seguridad ni de producto. Si faltan las env vars, o si Storage
// responde con error, el sistema sigue funcionando exactamente como hoy: la foto
// se guarda como data URL base64 en la columna (ver `handleWebhook.ts`, rama
// "imagen"). Nunca vale la pena arriesgar el piloto en producción por esto.
// ─────────────────────────────────────────────────────────────────────────────

// Decisión de diseño (vetable): nombre del bucket. Configurable por env para no
// atar el código a un nombre fijo, con un default razonable para no obligar a
// documentarlo si el operador ya lo llamó así.
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "wa-fotos";

// Decisión de diseño (vetable): 5 minutos de vida para la URL firmada. Sobra para
// que el panel cargue el chat y el navegador descargue la imagen; no vale la pena
// alargarlo porque se re-firma en cada lectura de la conversación.
const EXPIRACION_URL_FIRMADA_SEG = 300;

let avisoFaltaConfigMostrado = false;

function credencialesConfiguradas(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** ¿Está Supabase Storage configurado? Se expone para que otros módulos decidan sin duplicar el check. */
export function storageConfigurado(): boolean {
  return credencialesConfiguradas();
}

/** Avisa UNA sola vez por proceso (no en cada foto) que Storage no está configurado. */
function avisarFaltaConfigUnaVez(): void {
  if (avisoFaltaConfigMostrado) return;
  avisoFaltaConfigMostrado = true;
  console.warn(
    "[storage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configuradas: las fotos de WhatsApp se " +
      "siguen guardando como data URL base64 completa en wa_mensajes.media_url (comportamiento previo " +
      "a F9, no rompe nada). Configuralas para que las fotos nuevas ocupen ~200 bytes por fila en vez " +
      "de varios MB — ver .env.example, sección Supabase Storage.",
  );
}

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extensionDeMime(mimeType: string): string {
  return EXTENSION_POR_MIME[mimeType] ?? "bin";
}

/**
 * Ruta determinística del objeto en el bucket: `{tenantId}/{conversacionId}/{waMessageId}.{ext}`.
 * Determinística y sin colisiones entre negocios (prefijo por tenant, Carril F) ni
 * entre conversaciones; reintentos de Meta con el mismo `wa_message_id` pisan el
 * mismo objeto (subida idempotente) en vez de acumular basura.
 */
function rutaObjeto(tenantId: string, conversacionId: string, waMessageId: string, mimeType: string): string {
  const idSeguro = waMessageId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${tenantId}/${conversacionId}/${idSeguro}.${extensionDeMime(mimeType)}`;
}

/** Headers de autenticación del service role: Storage exige AMBOS, no solo Authorization. */
function headersAuth(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/**
 * Sube el binario de una foto al bucket privado y devuelve la RUTA del objeto
 * (no una URL: el bucket es privado, no hay URL pública). Lanza si Storage no
 * está configurado o si la subida falla — el LLAMADOR decide el fallback.
 */
export async function subirImagen(
  tenantId: string,
  conversacionId: string,
  waMessageId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  if (!credencialesConfiguradas()) throw new Error("Supabase Storage no configurado (faltan env vars)");
  const ruta = rutaObjeto(tenantId, conversacionId, waMessageId, mimeType);
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headersAuth(),
      "Content-Type": mimeType || "application/octet-stream",
      // Reintentos de Meta con el mismo wa_message_id no deben fallar por "ya existe".
      "x-upsert": "true",
    },
    // `fetch` tipa el body binario como Uint8Array, no como Buffer (aunque Buffer
    // extienda Uint8Array en runtime) — copia explícita para conformar el tipo.
    body: new Uint8Array(buffer),
    signal: conTimeout(TIMEOUT_STORAGE_MS),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`Supabase Storage subir (${res.status}): ${detalle.slice(0, 200)}`);
  }
  return ruta;
}

/**
 * Firma una URL de corta vida para un objeto ya subido. Devuelve `null` (no
 * lanza) si Storage no está configurado o si la firma falla — el panel debe
 * poder mostrar el resto del chat aunque una foto puntual no se pueda firmar.
 */
export async function firmarUrlImagen(
  ruta: string,
  expiracionSeg: number = EXPIRACION_URL_FIRMADA_SEG,
): Promise<string | null> {
  if (!credencialesConfiguradas()) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${ruta}`, {
      method: "POST",
      headers: { ...headersAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: expiracionSeg }),
      signal: conTimeout(TIMEOUT_STORAGE_MS),
    });
    if (!res.ok) {
      console.error(`[storage] no se pudo firmar la URL de "${ruta}" (${res.status})`);
      return null;
    }
    const { signedURL } = (await res.json()) as { signedURL: string };
    // Supabase devuelve una ruta relativa a /storage/v1 (ej: "/object/sign/bucket/ruta?token=…").
    return `${process.env.SUPABASE_URL}/storage/v1${signedURL}`;
  } catch (e) {
    console.error(`[storage] error firmando URL de "${ruta}":`, e);
    return null;
  }
}

/** ¿El valor guardado en `media_url` es un data URL legado (pre-F9), no una ruta de Storage? */
export function esDataUrlLegado(mediaUrl: string): boolean {
  return mediaUrl.startsWith("data:");
}

/**
 * Decide qué guardar en `wa_mensajes.media_url` para una foto entrante: intenta
 * subir el binario a Storage y persistir la RUTA corta; si Storage no está
 * configurado o la subida falla por cualquier motivo, cae al comportamiento
 * previo (persistir el data URL base64 completo que ya se armó para la IA) —
 * nunca deja la foto sin persistir por un problema de Storage.
 */
export async function resolverMediaAPersistir(
  tenantId: string,
  conversacionId: string,
  waMessageId: string,
  buffer: Buffer,
  mimeType: string,
  imagenDataUrlFallback: string,
): Promise<string> {
  if (!credencialesConfiguradas()) {
    avisarFaltaConfigUnaVez();
    return imagenDataUrlFallback;
  }
  try {
    return await subirImagen(tenantId, conversacionId, waMessageId, buffer, mimeType);
  } catch (e) {
    console.error("[storage] no se pudo subir la foto a Storage, se guarda el data URL como antes:", e);
    return imagenDataUrlFallback;
  }
}

/**
 * Resuelve el `mediaUrl` que ve el panel a partir de lo guardado en la columna:
 * - `null`/`undefined` → `undefined` (sin adjunto).
 * - data URL legado (`"data:…"`) → se devuelve TAL CUAL (compatibilidad con filas
 *   viejas mientras el script de migración no las haya movido a Storage).
 * - ruta de Storage → se firma (URL de corta vida); si no se puede firmar
 *   (Storage caído, mal configurado, o el objeto ya no existe), se devuelve
 *   `undefined` en vez de reventar el chat — el resto de la conversación se
 *   sigue mostrando.
 */
export async function resolverMediaParaPanel(mediaUrl: string | null | undefined): Promise<string | undefined> {
  if (!mediaUrl) return undefined;
  if (esDataUrlLegado(mediaUrl)) return mediaUrl;
  const firmada = await firmarUrlImagen(mediaUrl);
  return firmada ?? undefined;
}

// Solo para tests: permite resetear el flag del aviso único entre casos.
export function _resetearAvisoParaTests(): void {
  avisoFaltaConfigMostrado = false;
}
