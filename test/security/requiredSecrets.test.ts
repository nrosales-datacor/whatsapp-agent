import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { productionConfigWarnings, productionSecretProblems } from "../../src/platform/config/requiredSecrets";

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed de secretos al arrancar en producción (src/platform/config/
// requiredSecrets.ts, llamado por src/server.ts ANTES de cargar la app): sin
// PANEL_SESSION_SECRET o TOKENS_ENCRYPTION_KEY el proceso sale con error y la lista de
// todo lo que falta. El arranque se prueba en un subproceso real (`src/server.ts`).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "e".repeat(64);
const SECRET = "un-secreto-de-sesion-largo-0123456789";

test("secretos: fuera de producción no se exige nada", () => {
  assert.deepEqual(productionSecretProblems({}), []);
  assert.deepEqual(productionSecretProblems({ NODE_ENV: "development" }), []);
  assert.deepEqual(productionConfigWarnings({}), []);
});

test("secretos: en producción faltan los dos → dos problemas; secreto corto o clave sin formato también", () => {
  assert.equal(productionSecretProblems({ NODE_ENV: "production" }).length, 2);
  const short = productionSecretProblems({ NODE_ENV: "production", PANEL_SESSION_SECRET: "corto", TOKENS_ENCRYPTION_KEY: KEY });
  assert.equal(short.length, 1);
  assert.match(short[0], /PANEL_SESSION_SECRET/);
  const badKey = productionSecretProblems({ NODE_ENV: "production", PANEL_SESSION_SECRET: SECRET, TOKENS_ENCRYPTION_KEY: "no-es-hex" });
  assert.equal(badKey.length, 1);
  assert.match(badKey[0], /TOKENS_ENCRYPTION_KEY/);
  assert.deepEqual(productionSecretProblems({ NODE_ENV: "production", PANEL_SESSION_SECRET: SECRET, TOKENS_ENCRYPTION_KEY: KEY }), []);
});

test("secretos: avisos de producción por PUBLIC_BASE_URL y superadmin sin configurar", () => {
  const warnings = productionConfigWarnings({ NODE_ENV: "production" });
  assert.ok(warnings.some((w) => w.includes("PUBLIC_BASE_URL")));
  assert.ok(warnings.some((w) => w.includes("PANEL_SUPERADMIN_USERNAME")));
  assert.deepEqual(
    productionConfigWarnings({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://app.example.test",
      PANEL_SUPERADMIN_USERNAME: "root",
      PANEL_SUPERADMIN_HASH: "a:b",
    }),
    [],
  );
});

function startServer(env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "0", SENTRY_DSN: "", ...env },
    encoding: "utf8",
    timeout: 90_000,
  });
}

test("arranque en producción sin PANEL_SESSION_SECRET ni TOKENS_ENCRYPTION_KEY → sale con error listando los dos", () => {
  const r = startServer({ NODE_ENV: "production", PANEL_SESSION_SECRET: "", TOKENS_ENCRYPTION_KEY: "", DATABASE_URL: "" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Faltan secretos obligatorios en producción/);
  assert.match(r.stderr, /PANEL_SESSION_SECRET/);
  assert.match(r.stderr, /TOKENS_ENCRYPTION_KEY/);
  assert.doesNotMatch(r.stderr, /DATABASE_URL/, "corta antes de cualquier otra cosa (incluso de la base)");
});
