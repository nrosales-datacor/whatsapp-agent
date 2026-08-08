import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP F2 — cifrado en reposo del access_token de WhatsApp (src/config/secretos.ts).
//
// TOKENS_ENCRYPTION_KEY se fija ANTES de importar el módulo (se lee una sola vez al
// cargar, igual que PANEL_SESSION_SECRET en auth.ts) para que cifrar/descifrar en
// este proceso de test usen SIEMPRE la misma clave determinística.
//
// El caso "falta la clave" es la excepción: como la clave se lee al cargar el
// módulo, no se puede probar en este mismo proceso (ya quedó cargado con una clave
// válida). Se prueba en un subproceso limpio con `spawnSync`, que es también la
// única forma honesta de probar un `throw` al arrancar.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes en hex, válida y estable para el test

const { cifrar, descifrar } = await import("../../src/config/secretos");

test("cifrar → descifrar: round-trip devuelve el texto original", () => {
  const original = "EAAG_token_de_prueba_del_waba_12345";
  const blob = cifrar(original);
  assert.equal(descifrar(blob), original);
});

test("cifrar: dos cifrados del mismo texto dan blobs distintos (IV aleatorio)", () => {
  const original = "mismo-token-siempre";
  const blobA = cifrar(original);
  const blobB = cifrar(original);
  assert.notEqual(blobA, blobB);
  // Pero ambos descifran al mismo texto: la diferencia es solo el IV, no el contenido.
  assert.equal(descifrar(blobA), original);
  assert.equal(descifrar(blobB), original);
});

test("cifrar: el blob tiene el formato v1:<iv>:<tag>:<datos>", () => {
  const blob = cifrar("x");
  const partes = blob.split(":");
  assert.equal(partes.length, 4);
  assert.equal(partes[0], "v1");
});

test("descifrar: un blob manipulado falla la verificación de GCM (no descifra corrompido)", () => {
  const blob = cifrar("token-sensible");
  const partes = blob.split(":");
  // Alteramos un byte del ciphertext (última parte): el tag de autenticación de GCM
  // debe rechazarlo — no puede "descifrar mal" en silencio.
  const datosAlterados = partes[3].slice(0, -1) + (partes[3].slice(-1) === "A" ? "B" : "A");
  const manipulado = [partes[0], partes[1], partes[2], datosAlterados].join(":");
  assert.throws(() => descifrar(manipulado));
});

test("descifrar: un tag manipulado también falla la verificación", () => {
  const blob = cifrar("token-sensible");
  const partes = blob.split(":");
  const tagAlterado = partes[2].slice(0, -1) + (partes[2].slice(-1) === "A" ? "B" : "A");
  const manipulado = [partes[0], tagAlterado, partes[2], partes[3]].join(":");
  assert.throws(() => descifrar(manipulado));
});

test("descifrar: un valor sin prefijo 'v1:' se devuelve tal cual (tolerancia a texto plano heredado)", () => {
  const valorViejo = "EAAG_este_token_nunca_se_cifro";
  assert.equal(descifrar(valorViejo), valorViejo);
});

test("descifrar: string vacío (sin prefijo) también se devuelve tal cual, no revienta", () => {
  assert.equal(descifrar(""), "");
});

// ─── Fail-closed al arrancar sin la clave (subproceso, ver comentario de arriba) ──

function cargarSecretosEnSubproceso(env: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", 'await import("./src/config/secretos.ts");'],
    { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8" },
  );
}

test("arranque: falta TOKENS_ENCRYPTION_KEY con DATABASE_URL presente → falla con mensaje claro", () => {
  const r = cargarSecretosEnSubproceso({ DATABASE_URL: "postgres://x", TOKENS_ENCRYPTION_KEY: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TOKENS_ENCRYPTION_KEY es obligatoria/);
});

test("arranque: TOKENS_ENCRYPTION_KEY con formato inválido → falla con mensaje claro (aunque no haya DATABASE_URL)", () => {
  const r = cargarSecretosEnSubproceso({ DATABASE_URL: "", TOKENS_ENCRYPTION_KEY: "no-es-hex" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TOKENS_ENCRYPTION_KEY inválida/);
});

test("arranque: sin clave y SIN DATABASE_URL (dev) → NO falla, solo advierte", () => {
  const r = cargarSecretosEnSubproceso({ DATABASE_URL: "", TOKENS_ENCRYPTION_KEY: "" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /uso una clave aleatoria/);
});
