import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) para el segundo factor del superadmin (revisión de seguridad
// pre-venta 2026-10). Implementado a mano con node:crypto (HMAC), sin dependencias:
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
// El último paso aceptado vive en memoria: alcanza con un solo proceso web (el deploy
// actual); con varias réplicas, cada una tendría su propio registro (ver DEPLOY.md).
// ─────────────────────────────────────────────────────────────────────────────

const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PERIODO_SEG = 30;

export type AlgoritmoTotp = "sha1" | "sha256" | "sha512";

/** Codifica bytes en base32 (RFC 4648, sin padding) — el formato que leen las apps autenticadoras. */
export function codificarBase32(buf: Buffer): string {
  let bits = 0;
  let valor = 0;
  let out = "";
  for (const b of buf) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  return out;
}

/** Decodifica base32 (tolera minúsculas, espacios y padding). null si trae caracteres inválidos. */
export function decodificarBase32(s: string): Buffer | null {
  const limpio = s.replace(/[\s=-]/g, "").toUpperCase();
  if (!limpio) return null;
  let bits = 0;
  let valor = 0;
  const out: number[] = [];
  for (const ch of limpio) {
    const i = ALFABETO_BASE32.indexOf(ch);
    if (i === -1) return null;
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) para un contador dado. */
export function hotp(clave: Buffer, contador: number, digitos = 6, algoritmo: AlgoritmoTotp = "sha1"): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac(algoritmo, clave).update(c).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digitos).padStart(digitos, "0");
}

/** Paso TOTP (contador) para un instante en ms. */
export function pasoTotp(ahoraMs: number): number {
  return Math.floor(ahoraMs / 1000 / PERIODO_SEG);
}

/** Código TOTP para un instante (ms). */
export function totp(clave: Buffer, ahoraMs: number, digitos = 6, algoritmo: AlgoritmoTotp = "sha1"): string {
  return hotp(clave, pasoTotp(ahoraMs), digitos, algoritmo);
}

function igualesTiempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Busca el paso (dentro de la ventana ±`ventana`) cuyo código coincide. Devuelve el
 * paso o null. No aplica anti-replay (eso es `consumirTotp`).
 */
export function pasoQueCoincide(clave: Buffer, codigo: string, ahoraMs: number, ventana = 1): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const actual = pasoTotp(ahoraMs);
  let encontrado: number | null = null;
  // Se recorre TODA la ventana (sin cortar al primer acierto) para no filtrar por timing
  // en qué posición de la ventana estaba el código.
  for (let d = -ventana; d <= ventana; d++) {
    if (igualesTiempoConstante(hotp(clave, actual + d), codigo) && encontrado === null) encontrado = actual + d;
  }
  return encontrado;
}

// Último paso aceptado por secreto (anti-replay). La clave es un hash del secreto para
// no guardar el secreto mismo como clave de un Map.
const ultimoPasoAceptado = new Map<string, number>();

export type ResultadoTotp = "ok" | "invalido" | "reusado";

/**
 * Verifica `codigo` contra el secreto base32 con ventana ±1 y anti-replay: solo se acepta
 * si su paso es POSTERIOR al último código aceptado con este secreto.
 */
export function consumirTotp(secretoBase32: string, codigo: string, ahoraMs = Date.now()): ResultadoTotp {
  const clave = decodificarBase32(secretoBase32);
  if (!clave || clave.length < 10) return "invalido"; // secreto mal configurado → falla cerrado
  const paso = pasoQueCoincide(clave, String(codigo ?? "").trim(), ahoraMs);
  if (paso === null) return "invalido";
  const id = crypto.createHash("sha256").update(clave).digest("hex");
  const ultimo = ultimoPasoAceptado.get(id);
  if (ultimo !== undefined && paso <= ultimo) return "reusado";
  ultimoPasoAceptado.set(id, paso);
  return "ok";
}

/** URI otpauth:// (formato de Google Authenticator) para cargar el secreto con un QR o a mano. */
export function uriOtpauth(secretoBase32: string, cuenta: string, emisor: string): string {
  // encodeURIComponent (no URLSearchParams): algunas apps muestran el "+" literal en vez de un espacio.
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  const issuer = encodeURIComponent(emisor);
  return `otpauth://totp/${etiqueta}?secret=${secretoBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${PERIODO_SEG}`;
}

/** Solo para tests: el anti-replay es estado de módulo. */
export function _resetParaTests(): void {
  ultimoPasoAceptado.clear();
}
