import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isKnownPlaceholder,
  MIN_SECRET_LENGTH,
  productionConfigWarnings,
  productionSecretProblems,
} from "../../src/platform/config/requiredSecrets";

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed de secretos al arrancar en producción (src/platform/config/
// requiredSecrets.ts, llamado por src/server.ts ANTES de cargar la app): sin
// PANEL_SESSION_SECRET o TOKENS_ENCRYPTION_KEY el proceso sale con error y la lista de
// todo lo que falta. El arranque se prueba en un subproceso real (`src/server.ts`).
// También rechaza los placeholders PÚBLICOS de .env.example y los secretos cortos o
// adivinables (V2-03): copiar el ejemplo a producción permitiría forjar sesiones.
// ─────────────────────────────────────────────────────────────────────────────

// Valores fijos con pinta de aleatorios (NO son secretos de ningún sistema real).
const KEY = "3f9c1a7e5b2d8046c1e9a3f75d0b2c84e6a1f9d37b5c0e28a4d6f1b39c7e0a52";
const SECRET = "un-secreto-de-sesion-largo-0123456789";
const STRONG = "9b1e4c7a2f5d8036e1c4a7b0d3f6928a"; // 32 hex: el formato del app secret de Meta

/** Valor (sin comillas) de `NOMBRE=` en .env.example, esté activo o comentado. */
function envExampleValue(name: string): string | undefined {
  const text = readFileSync(".env.example", "utf8");
  const m = text.match(new RegExp(`^#?\\s*${name}=(.*)$`, "m"));
  return m?.[1].trim().replace(/^["']|["']$/g, "") || undefined;
}

const prod = (extra: Record<string, string>) =>
  productionSecretProblems({ NODE_ENV: "production", PANEL_SESSION_SECRET: SECRET, TOKENS_ENCRYPTION_KEY: KEY, ...extra });

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

test("secretos: el PANEL_SESSION_SECRET de .env.example NO pasa en producción (aunque sea largo)", () => {
  const placeholder = envExampleValue("PANEL_SESSION_SECRET");
  assert.ok(placeholder && placeholder.length >= 16, ".env.example trae un placeholder de sesión");
  const problems = prod({ PANEL_SESSION_SECRET: placeholder });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PANEL_SESSION_SECRET es el valor de ejemplo/);
  assert.ok(!problems[0].includes(placeholder), "el mensaje no repite el valor");
  // Variantes obvias (mayúsculas, espacios, otras palabras de ejemplo) tampoco.
  assert.equal(prod({ PANEL_SESSION_SECRET: ` ${placeholder.toUpperCase()} ` }).length, 1);
  assert.equal(prod({ PANEL_SESSION_SECRET: "changeme-changeme-changeme-0123456789" }).length, 1);
});

test("secretos: PANEL_SESSION_SECRET corto o de poca entropía → problema; uno al azar → ok", () => {
  assert.match(prod({ PANEL_SESSION_SECRET: "a1b2c3d4e5f6a7b8c9d0" })[0], /PANEL_SESSION_SECRET es corto/); // 20 < 32
  assert.match(prod({ PANEL_SESSION_SECRET: "x".repeat(64) })[0], /poca entropía/);
  assert.match(prod({ PANEL_SESSION_SECRET: "0123456789abcdef".repeat(3) })[0], /poca entropía/); // patrón repetido
  assert.match(prod({ PANEL_SESSION_SECRET: "abababababababababababababababab12" })[0], /poca entropía/);
  assert.deepEqual(prod({ PANEL_SESSION_SECRET: KEY }), []);
  assert.deepEqual(prod({ PANEL_SESSION_SECRET: STRONG }), []);
  assert.equal(MIN_SECRET_LENGTH, 32);
});

test("secretos: TOKENS_ENCRYPTION_KEY con formato hex pero repetida (\"eee…\") → problema", () => {
  assert.match(prod({ TOKENS_ENCRYPTION_KEY: "e".repeat(64) })[0], /TOKENS_ENCRYPTION_KEY tiene poca entropía/);
});

test("secretos: WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN solo se validan si están definidos", () => {
  assert.deepEqual(prod({}), [], "sin definir no frena");
  assert.deepEqual(prod({ WHATSAPP_APP_SECRET: "  ", WHATSAPP_VERIFY_TOKEN: "" }), [], "vacíos = sin definir");
  const verifyPlaceholder = envExampleValue("WHATSAPP_VERIFY_TOKEN");
  assert.ok(verifyPlaceholder, ".env.example trae un placeholder del verify token");
  assert.match(prod({ WHATSAPP_VERIFY_TOKEN: verifyPlaceholder })[0], /WHATSAPP_VERIFY_TOKEN es el valor de ejemplo/);
  assert.match(prod({ WHATSAPP_VERIFY_TOKEN: "mi-token" })[0], /WHATSAPP_VERIFY_TOKEN es corto/);
  assert.match(prod({ WHATSAPP_APP_SECRET: "cambiame-por-el-app-secret-de-meta-real" })[0], /WHATSAPP_APP_SECRET es el valor de ejemplo/);
  assert.match(prod({ WHATSAPP_APP_SECRET: "abc123" })[0], /WHATSAPP_APP_SECRET es corto/);
  assert.match(prod({ WHATSAPP_APP_SECRET: "1".repeat(32) })[0], /WHATSAPP_APP_SECRET tiene poca entropía/);
  assert.deepEqual(prod({ WHATSAPP_APP_SECRET: STRONG, WHATSAPP_VERIFY_TOKEN: KEY }), []);
  // Se acumulan con los demás problemas (un solo mensaje con todo).
  assert.equal(
    productionSecretProblems({ NODE_ENV: "production", WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }).length,
    4,
  );
});

test("secretos: HEALTH_DETAIL_TOKEN con el placeholder de .env.example → problema", () => {
  const placeholder = envExampleValue("HEALTH_DETAIL_TOKEN");
  assert.ok(placeholder);
  assert.match(prod({ HEALTH_DETAIL_TOKEN: placeholder })[0], /HEALTH_DETAIL_TOKEN/);
  assert.deepEqual(prod({ HEALTH_DETAIL_TOKEN: KEY }), []);
});

test("secretos: todo placeholder de secreto en .env.example está en la lista de rechazados", () => {
  // Si alguien agrega un ejemplo nuevo a .env.example para estos secretos, este test obliga
  // a sumarlo a KNOWN_PLACEHOLDERS (o a dejarlo vacío) — así nunca pasa en producción.
  for (const name of ["PANEL_SESSION_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "HEALTH_DETAIL_TOKEN"]) {
    const value = envExampleValue(name);
    if (value) assert.ok(isKnownPlaceholder(value), `${name}: el ejemplo de .env.example no está en KNOWN_PLACEHOLDERS`);
  }
  assert.ok(isKnownPlaceholder(envExampleValue("PANEL_SUPERADMIN_HASH") ?? ""));
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

test("arranque en producción con el PANEL_SESSION_SECRET de .env.example → NO arranca", () => {
  const placeholder = envExampleValue("PANEL_SESSION_SECRET")!;
  const r = startServer({ NODE_ENV: "production", PANEL_SESSION_SECRET: placeholder, TOKENS_ENCRYPTION_KEY: KEY, DATABASE_URL: "" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Faltan secretos obligatorios en producción/);
  assert.match(r.stderr, /PANEL_SESSION_SECRET es el valor de ejemplo/);
  assert.ok(!r.stderr.includes(placeholder), "el log no repite el valor");
  assert.doesNotMatch(r.stderr, /DATABASE_URL/, "corta antes de cualquier otra cosa (incluso de la base)");
});
