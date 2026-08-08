import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Cifrado en reposo del `access_token` de WhatsApp de cada tenant (ROADMAP F2).
//
// Por qué: `wa_tenants.access_token` guardaba el token del WABA de cada cliente en
// texto plano. Un dump de la base, un backup mal guardado o una credencial de
// Supabase filtrada entregaban la capacidad de ENVIAR WhatsApp suplantando a
// cualquiera de los negocios — daño reputacional irreversible sobre clientes que
// pagan. AES-256-GCM (autenticado: detecta manipulación, no solo la oculta) con
// `node:crypto` — cero dependencias nuevas (política del repo).
//
// Formato del blob: "v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>". El prefijo
// de versión permite rotar de algoritmo el día de mañana sin tener que adivinar
// con qué se cifró un valor viejo (se prueba "v1", si no matchea se prueba el
// siguiente esquema, etc.).
//
// Quién llama a esto: `tenantStore.ts` (cifra al escribir en `crearTenant`,
// descifra SOLO al construir el caché en `filaATenant`) y `scripts/seedTenants.ts`
// / `scripts/cifrarTokens.ts`. El resto del código (incluido `whatsapp/client.ts`)
// sigue viendo `tenant.accessToken` en claro: no cambia nada fuera de estos
// puntos de entrada/salida a la base.
// ─────────────────────────────────────────────────────────────────────────────

const ALGORITMO = "aes-256-gcm";
const PREFIJO = "v1";
const IV_BYTES = 12; // tamaño recomendado de IV para GCM (no 16): evita reusar el modo CTR interno con menos margen.

const CLAVE = obtenerClave();

/**
 * Clave maestra desde `TOKENS_ENCRYPTION_KEY` (obligatoria si hay `DATABASE_URL`).
 * Mismo patrón fail-closed que `PANEL_SESSION_SECRET` (`src/panel/auth.ts`): en
 * producción (o con una base configurada) sin la clave, el proceso NO debe
 * arrancar — es preferible un deploy caído y visible a guardar tokens sin cifrar
 * por un `.env` incompleto. En desarrollo sin base se permite una clave aleatoria
 * por arranque: no hay tokens persistidos que descifrar todavía (y `crearTenant`
 * ya lanza `SIN_DB` sin base, así que `cifrar`/`descifrar` no se ejercitan de verdad).
 */
function obtenerClave(): Buffer {
  const hex = process.env.TOKENS_ENCRYPTION_KEY;
  const enProd = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        "TOKENS_ENCRYPTION_KEY inválida: debe ser una cadena hexadecimal de 64 caracteres (32 bytes). " +
          'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return Buffer.from(hex, "hex");
  }
  if (enProd) {
    throw new Error(
      "TOKENS_ENCRYPTION_KEY es obligatoria en producción (32 bytes en hex, 64 caracteres): sin ella no se " +
        "puede cifrar el access_token de cada WABA. Generá una con: " +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  console.warn(
    "[secretos] TOKENS_ENCRYPTION_KEY sin configurar: uso una clave aleatoria para esta corrida " +
      "(lo cifrado ahora no se podrá descifrar tras reiniciar). Solo válido en desarrollo sin base de datos.",
  );
  return crypto.randomBytes(32);
}

/**
 * Cifra un texto plano (p. ej. un access_token de WhatsApp) con AES-256-GCM e IV
 * aleatorio de 12 bytes por llamada (nunca fijo: reusar IV con la misma clave
 * rompe la confidencialidad de GCM). No maneja `null`/`undefined` a propósito —
 * esa decisión (no cifrar un token ausente) la toma el caller, ver `tenantStore.ts`.
 */
export function cifrar(textoPlano: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, CLAVE, iv);
  const cifrado = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIJO, iv.toString("base64url"), tag.toString("base64url"), cifrado.toString("base64url")].join(":");
}

/**
 * Descifra un blob producido por `cifrar`. Lanza si el `tag` de GCM no valida
 * (blob manipulado o cifrado con otra clave) — nunca devuelve texto corrompido.
 *
 * Tolerancia a texto plano heredado (TRANSICIÓN): si el valor no empieza con el
 * prefijo de versión "v1:", se asume que es un token guardado ANTES de este
 * cambio y se devuelve tal cual, con un `console.warn`. Sin esto, este mismo
 * deploy rompería a todos los tenants que ya tienen un token en texto plano en la
 * base. Migrar con `scripts/cifrarTokens.ts` y luego QUITAR esta rama en un
 * commit posterior (una vez confirmado que no queda ningún token en claro).
 */
export function descifrar(blob: string): string {
  if (!blob.startsWith(`${PREFIJO}:`)) {
    console.warn("[secretos] valor sin prefijo 'v1:' — se asume texto plano heredado (pre-cifrado). Correr scripts/cifrarTokens.ts.");
    return blob;
  }
  const partes = blob.split(":");
  if (partes.length !== 4) {
    throw new Error("Blob cifrado con formato inválido (se esperaba 'v1:<iv>:<tag>:<datos>')");
  }
  const [, ivB64, tagB64, datosB64] = partes;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const datos = Buffer.from(datosB64, "base64url");
  const decipher = crypto.createDecipheriv(ALGORITMO, CLAVE, iv);
  decipher.setAuthTag(tag); // si el blob fue manipulado, esto hace fallar decipher.final() abajo
  const textoPlano = Buffer.concat([decipher.update(datos), decipher.final()]);
  return textoPlano.toString("utf8");
}
