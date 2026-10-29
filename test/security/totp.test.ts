import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { _resetForTests, consumeTotp, decodeBase32, encodeBase32, hotp, otpauthUri, totp } from "../../src/platform/auth/totp";
import { getClientIp } from "../../src/platform/net/clientIp";

// ─────────────────────────────────────────────────────────────────────────────
// Invariantes puros (sin base ni HTTP):
//   • TOTP (RFC 6238) contra los vectores de prueba oficiales del Apéndice B, base32
//     (RFC 4648), ventana ±1 y anti-replay.
//   • IP del cliente detrás de proxy (`TRUST_PROXY`): un X-Forwarded-For falsificado no
//     cambia la IP que ve el rate limit.
// ─────────────────────────────────────────────────────────────────────────────

// ─── TOTP: vectores del RFC 6238, Apéndice B ────────────────────────────────

const SEED_SHA1 = Buffer.from("12345678901234567890");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012");
const SEED_SHA512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");

const VECTORS: [number, string, string, string][] = [
  // [tiempo (s), SHA1, SHA256, SHA512] — 8 dígitos, X = 30 s, T0 = 0
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("TOTP: vectores de prueba del RFC 6238 (SHA1, SHA256, SHA512, 8 dígitos)", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    assert.equal(totp(SEED_SHA1, t * 1000, 8, "sha1"), sha1, `SHA1 t=${t}`);
    assert.equal(totp(SEED_SHA256, t * 1000, 8, "sha256"), sha256, `SHA256 t=${t}`);
    assert.equal(totp(SEED_SHA512, t * 1000, 8, "sha512"), sha512, `SHA512 t=${t}`);
  }
});

test("HOTP: vectores del RFC 4226 (Apéndice D, 6 dígitos)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(SEED_SHA1, counter), code, `contador ${counter}`));
});

test("base32 (RFC 4648): vectores y round-trip; rechaza caracteres inválidos", () => {
  assert.equal(encodeBase32(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(encodeBase32(Buffer.from("f")), "MY");
  assert.equal(decodeBase32("MZXW6YTBOI")?.toString(), "foobar");
  assert.equal(decodeBase32("mzxw 6ytb oi======")?.toString(), "foobar", "tolera minúsculas, espacios y padding");
  assert.equal(decodeBase32("MZXW6YTB0I"), null, "el 0 no es base32");
  assert.equal(encodeBase32(SEED_SHA1), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
});

const SECRET = encodeBase32(SEED_SHA1);
const T = 1_700_000_000_000; // instante fijo (ms)
const codeAt = (ms: number) => totp(SEED_SHA1, ms);

test("consumeTotp: acepta el código actual y los de ±1 paso; rechaza ±2 y basura", () => {
  _resetForTests();
  assert.equal(consumeTotp(SECRET, codeAt(T - 60_000), T), "invalid", "-2 pasos: fuera de ventana");
  assert.equal(consumeTotp(SECRET, codeAt(T + 60_000), T), "invalid", "+2 pasos: fuera de ventana");
  assert.equal(consumeTotp(SECRET, "12345", T), "invalid");
  assert.equal(consumeTotp(SECRET, "abcdef", T), "invalid");
  assert.equal(consumeTotp(SECRET, codeAt(T - 30_000), T), "ok", "-1 paso (reloj del celular atrasado)");
  _resetForTests();
  assert.equal(consumeTotp(SECRET, codeAt(T + 30_000), T), "ok", "+1 paso (reloj adelantado)");
  _resetForTests();
  assert.equal(consumeTotp(SECRET, codeAt(T), T), "ok");
});

test("consumeTotp: anti-replay — el mismo código (o uno anterior) no se acepta dos veces", () => {
  _resetForTests();
  const code = codeAt(T);
  assert.equal(consumeTotp(SECRET, code, T), "ok");
  assert.equal(consumeTotp(SECRET, code, T + 5_000), "reused", "mismo código, aún dentro de la ventana");
  assert.equal(consumeTotp(SECRET, codeAt(T - 30_000), T + 5_000), "reused", "código de un paso ANTERIOR al aceptado");
  assert.equal(consumeTotp(SECRET, codeAt(T + 30_000), T + 30_000), "ok", "el código siguiente sí");
});

test("consumeTotp: secreto mal configurado → siempre inválido (falla cerrado)", () => {
  _resetForTests();
  assert.equal(consumeTotp("", "123456", T), "invalid");
  assert.equal(consumeTotp("NO-ES-BASE32-!!", codeAt(T), T), "invalid");
  assert.equal(consumeTotp("MZXW6", codeAt(T), T), "invalid", "secreto demasiado corto");
});

test("otpauthUri: formato de Google Authenticator", () => {
  const uri = otpauthUri(SECRET, "admin", "Selyon Admin");
  assert.match(uri, /^otpauth:\/\/totp\/Selyon%20Admin%3Aadmin\?/);
  assert.match(uri, new RegExp(`secret=${SECRET}`));
  assert.match(uri, /issuer=Selyon%20Admin/);
  assert.match(uri, /digits=6&period=30/);
});

// ─── IP del cliente detrás de proxy (TRUST_PROXY) ───────────────────────────

function req(remote: string, xff?: string): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} } as unknown as IncomingMessage;
}

test("getClientIp: sin TRUST_PROXY ignora X-Forwarded-For (lo manda el cliente, no es confiable)", () => {
  delete process.env.TRUST_PROXY;
  assert.equal(getClientIp(req("203.0.113.5", "1.1.1.1")), "203.0.113.5");
  assert.equal(getClientIp(req("::ffff:203.0.113.5")), "203.0.113.5", "IPv4 mapeada en IPv6 se normaliza");
});

test("getClientIp: TRUST_PROXY=loopback toma el último salto NO confiable (el que agregó el proxy)", () => {
  process.env.TRUST_PROXY = "loopback";
  // Caddy/nginx local agrega la IP real al final; lo de la izquierda lo inventó el cliente.
  assert.equal(getClientIp(req("127.0.0.1", "6.6.6.6, 203.0.113.9")), "203.0.113.9");
  assert.equal(getClientIp(req("127.0.0.1", "7.7.7.7, 203.0.113.9")), "203.0.113.9", "rotar lo falsificado no cambia la IP");
  // Una conexión DIRECTA (no desde el proxy) no puede inyectar nada.
  assert.equal(getClientIp(req("198.51.100.4", "127.0.0.1")), "198.51.100.4");
  // Varios proxies de confianza encadenados.
  process.env.TRUST_PROXY = "127.0.0.1,10.0.0.0/8";
  assert.equal(getClientIp(req("127.0.0.1", "1.2.3.4, 203.0.113.9, 10.1.2.3")), "203.0.113.9");
});

test("getClientIp: TRUST_PROXY=N cuenta N saltos desde el socket", () => {
  process.env.TRUST_PROXY = "1";
  assert.equal(getClientIp(req("127.0.0.1", "6.6.6.6, 203.0.113.9")), "203.0.113.9");
  assert.equal(getClientIp(req("127.0.0.1")), "127.0.0.1", "sin header: el socket");
  process.env.TRUST_PROXY = "2";
  assert.equal(getClientIp(req("127.0.0.1", "6.6.6.6, 203.0.113.9, 10.0.0.2")), "203.0.113.9");
  delete process.env.TRUST_PROXY;
});
