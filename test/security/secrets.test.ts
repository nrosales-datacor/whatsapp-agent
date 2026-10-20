import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Cifrado en reposo de secretos de terceros (src/platform/crypto/secrets.ts).
//
// TOKENS_ENCRYPTION_KEY se fija ANTES de importar el módulo (se lee una sola vez al
// cargar, igual que PANEL_SESSION_SECRET en sessionToken.ts) para que encrypt/decrypt en
// este proceso usen SIEMPRE la misma clave determinística.
//
// El caso "falta la clave" es la excepción: como la clave se lee al cargar el módulo, no
// se puede probar en este mismo proceso. Se prueba en un subproceso limpio con
// `spawnSync`, que es también la única forma honesta de probar un `throw` al arrancar.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes en hex, válida y estable para el test

const { encrypt, decrypt } = await import("../../src/platform/crypto/secrets");

/** Cambia el primer carácter de un string base64url (todos sus bits son de datos). */
const flipFirstChar = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);

test("encrypt → decrypt: round-trip devuelve el texto original", () => {
  const original = "EAAG_token_de_prueba_del_waba_12345";
  assert.equal(decrypt(encrypt(original)), original);
});

test("encrypt: dos cifrados del mismo texto dan blobs distintos (IV aleatorio)", () => {
  const original = "mismo-token-siempre";
  const blobA = encrypt(original);
  const blobB = encrypt(original);
  assert.notEqual(blobA, blobB);
  // Pero ambos descifran al mismo texto: la diferencia es solo el IV, no el contenido.
  assert.equal(decrypt(blobA), original);
  assert.equal(decrypt(blobB), original);
});

test("encrypt: el blob tiene el formato v1:<iv>:<tag>:<datos>", () => {
  const parts = encrypt("x").split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "v1");
});

test("decrypt: un blob manipulado falla la verificación de GCM (no descifra corrompido)", () => {
  const parts = encrypt("token-sensible").split(":");
  // Alteramos el ciphertext (última parte): el tag de autenticación de GCM debe rechazarlo —
  // no puede "descifrar mal" en silencio. Se cambia el PRIMER carácter: en base64url el
  // último puede llevar bits de relleno y cambiarlo a veces no altera ningún byte.
  const tampered = flipFirstChar(parts[3]);
  assert.throws(() => decrypt([parts[0], parts[1], parts[2], tampered].join(":")));
});

test("decrypt: un tag manipulado también falla la verificación", () => {
  const parts = encrypt("token-sensible").split(":");
  const tamperedTag = flipFirstChar(parts[2]);
  assert.throws(() => decrypt([parts[0], parts[1], tamperedTag, parts[3]].join(":")));
});

test("decrypt: un valor sin el prefijo 'v1:' es un error (no se tolera texto plano heredado)", () => {
  assert.throws(() => decrypt("EAAG_este_token_nunca_se_cifro"), /formato inválido/);
  assert.throws(() => decrypt(""), /formato inválido/);
  assert.throws(() => decrypt("v2:a:b:c"), /formato inválido/);
});

// ─── Fail-closed al arrancar sin la clave (subproceso, ver comentario de arriba) ──

function loadInSubprocess(env: Record<string, string | undefined>) {
  // --input-type=module: el `-e` corre como ESM (con top-level await), no como CommonJS.
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/platform/crypto/secrets.ts");'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("arranque: falta TOKENS_ENCRYPTION_KEY con DATABASE_URL presente → falla con mensaje claro", () => {
  const r = loadInSubprocess({ DATABASE_URL: "postgres://x", TOKENS_ENCRYPTION_KEY: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TOKENS_ENCRYPTION_KEY es obligatoria/);
});

test("arranque: TOKENS_ENCRYPTION_KEY con formato inválido → falla con mensaje claro (aunque no haya DATABASE_URL)", () => {
  const r = loadInSubprocess({ DATABASE_URL: "", TOKENS_ENCRYPTION_KEY: "no-es-hex" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TOKENS_ENCRYPTION_KEY inválida/);
});

test("arranque: sin clave y SIN DATABASE_URL (dev) → NO falla, solo advierte", () => {
  const r = loadInSubprocess({ DATABASE_URL: "", TOKENS_ENCRYPTION_KEY: "", NODE_ENV: "development" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /uso una clave aleatoria/);
});
