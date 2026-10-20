import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Cifrado en reposo de secretos de terceros que hay que guardar en la base (p. ej. el
// access_token de WhatsApp de cada negocio).
//
// Por qué: un token así permite ENVIAR mensajes suplantando al negocio. En texto plano,
// un dump de la base, un backup mal guardado o una credencial de Supabase filtrada
// entregan esa capacidad para TODOS los negocios — daño reputacional irreversible.
// AES-256-GCM (autenticado: detecta manipulación, no solo la oculta) con `node:crypto` —
// cero dependencias nuevas (política del repo).
//
// Formato del blob: "v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>". El prefijo de
// versión permite rotar de algoritmo el día de mañana sin tener que adivinar con qué se
// cifró un valor viejo.
//
// Se cifra al escribir en la base y se descifra solo al leer para usarlo: el resto del
// código nunca ve el blob.
// ─────────────────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const PREFIX = "v1";
const IV_BYTES = 12; // tamaño recomendado de IV para GCM (no 16)

const KEY = loadKey();

/**
 * Clave maestra desde `TOKENS_ENCRYPTION_KEY` (obligatoria en producción o si hay
 * `DATABASE_URL`). Mismo patrón fail-closed que `PANEL_SESSION_SECRET`: sin la clave el
 * proceso NO arranca — es preferible un deploy caído y visible a guardar tokens sin
 * cifrar por un `.env` incompleto. En desarrollo sin base configurada se permite una
 * clave aleatoria por arranque (lo cifrado no sobrevive al reinicio).
 */
function loadKey(): Buffer {
  const hex = process.env.TOKENS_ENCRYPTION_KEY;
  const inProduction = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        "TOKENS_ENCRYPTION_KEY inválida: debe ser una cadena hexadecimal de 64 caracteres (32 bytes). " +
          'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return Buffer.from(hex, "hex");
  }
  if (inProduction) {
    throw new Error(
      "TOKENS_ENCRYPTION_KEY es obligatoria en producción (32 bytes en hex, 64 caracteres): sin ella no se " +
        "pueden cifrar los secretos de cada negocio. Generá una con: " +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  console.warn(
    "[secrets] TOKENS_ENCRYPTION_KEY sin configurar: uso una clave aleatoria para esta corrida " +
      "(lo cifrado ahora no se podrá descifrar tras reiniciar). Solo válido en desarrollo sin base de datos.",
  );
  return crypto.randomBytes(32);
}

/**
 * Cifra un texto plano con AES-256-GCM e IV aleatorio de 12 bytes por llamada (nunca
 * fijo: reusar IV con la misma clave rompe la confidencialidad de GCM). No maneja
 * `null`/`undefined` a propósito: no cifrar un secreto ausente lo decide el llamador.
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/**
 * Descifra un blob producido por `encrypt`. Lanza si el blob no tiene el formato
 * esperado o si el `tag` de GCM no valida (blob manipulado o cifrado con otra clave) —
 * nunca devuelve texto corrompido ni un valor en claro "heredado": el esquema nace con
 * todo cifrado, así que un valor sin prefijo es un error, no un caso a tolerar.
 */
export function decrypt(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Blob cifrado con formato inválido (se esperaba 'v1:<iv>:<tag>:<datos>')");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag); // si el blob fue manipulado, esto hace fallar decipher.final() abajo
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
