import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) para el segundo factor. Implementado a mano con node:crypto (HMAC),
// sin dependencias:
//
//   HOTP(K, C) = Truncar(HMAC-SHA1(K, C)) mod 10^d            (RFC 4226)
//   TOTP(K, t) = HOTP(K, floor((t - T0) / X))   con T0 = 0, X = 30 s   (RFC 6238)
//
// Es lo que implementan Google Authenticator, Authy, 1Password, Bitwarden, etc. con los
// parámetros por defecto (SHA-1, 6 dígitos, 30 s) — los que se usan acá. SHA-256/512 y
// 8 dígitos se soportan solo para poder verificar los vectores de prueba del RFC.
//
// Verificación con ventana ±1 paso (tolera ~30 s de desfase de reloj del celular) y
// ANTI-REPLAY: un código ya aceptado (o uno de un paso anterior) no se acepta de nuevo,
// aunque siga dentro de la ventana. Sin esto, alguien que mira el código por encima del
// hombro (o lo intercepta) podría usarlo una segunda vez en los ~90 s que dura válido.
// El último paso aceptado vive en memoria: alcanza con un solo proceso web; con varias
// réplicas, cada una tendría su propio registro (ver DEPLOY.md).
// ─────────────────────────────────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PERIOD_SEC = 30;

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

/** Codifica bytes en base32 (RFC 4648, sin padding) — el formato que leen las apps autenticadoras. */
export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodifica base32 (tolera minúsculas, espacios y padding). null si trae caracteres inválidos. */
export function decodeBase32(s: string): Buffer | null {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32_ALPHABET.indexOf(ch);
    if (i === -1) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) para un contador dado. */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = "sha1"): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, key).update(c).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Paso TOTP (contador) para un instante en ms. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SEC);
}

/** Código TOTP para un instante (ms). */
export function totp(key: Buffer, nowMs: number, digits = 6, algorithm: TotpAlgorithm = "sha1"): string {
  return hotp(key, totpStep(nowMs), digits, algorithm);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Busca el paso (dentro de la ventana ±`window`) cuyo código coincide. Devuelve el paso o
 * null. No aplica anti-replay (eso es `consumeTotp`).
 */
export function matchingStep(key: Buffer, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  let found: number | null = null;
  // Se recorre TODA la ventana (sin cortar al primer acierto) para no filtrar por timing
  // en qué posición de la ventana estaba el código.
  for (let d = -window; d <= window; d++) {
    if (constantTimeEqual(hotp(key, current + d), code) && found === null) found = current + d;
  }
  return found;
}

// Último paso aceptado por secreto (anti-replay). La clave es un hash del secreto para no
// guardar el secreto mismo como clave de un Map.
const lastAcceptedStep = new Map<string, number>();

export type TotpResult = "ok" | "invalid" | "reused";

/**
 * Verifica `code` contra el secreto base32 con ventana ±1 y anti-replay: solo se acepta
 * si su paso es POSTERIOR al último código aceptado con este secreto.
 */
export function consumeTotp(secretBase32: string, code: string, nowMs = Date.now()): TotpResult {
  const key = decodeBase32(secretBase32);
  if (!key || key.length < 10) return "invalid"; // secreto mal configurado → falla cerrado
  const step = matchingStep(key, String(code ?? "").trim(), nowMs);
  if (step === null) return "invalid";
  const id = crypto.createHash("sha256").update(key).digest("hex");
  const last = lastAcceptedStep.get(id);
  if (last !== undefined && step <= last) return "reused";
  lastAcceptedStep.set(id, step);
  return "ok";
}

/** URI otpauth:// (formato de Google Authenticator) para cargar el secreto con un QR o a mano. */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  // encodeURIComponent (no URLSearchParams): algunas apps muestran el "+" literal en vez de un espacio.
  const label = encodeURIComponent(`${issuer}:${account}`);
  const issuerParam = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuerParam}&algorithm=SHA1&digits=6&period=${PERIOD_SEC}`;
}

/** Solo para tests: el anti-replay es estado de módulo. */
export function _resetForTests(): void {
  lastAcceptedStep.clear();
}
