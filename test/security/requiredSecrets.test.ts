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

test("secretos: avisos de producción por PUBLIC_BASE_URL, superadmin y Sentry sin configurar", () => {
  const warnings = productionConfigWarnings({ NODE_ENV: "production" });
  assert.ok(warnings.some((w) => w.includes("PUBLIC_BASE_URL")));
  assert.ok(warnings.some((w) => w.includes("PANEL_SUPERADMIN_USERNAME")));
  // Sin DSN se advierte, pero NO se frena el arranque (decisión del usuario).
  assert.ok(warnings.some((w) => w.includes("SENTRY_DSN")));
  assert.ok(!productionSecretProblems({ NODE_ENV: "production" }).some((p) => p.includes("SENTRY_DSN")));
  assert.deepEqual(
    productionConfigWarnings({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://app.example.test",
      PANEL_SUPERADMIN_USERNAME: "root",
      PANEL_SUPERADMIN_HASH: "a:b",
      SENTRY_DSN: "https://clavepublica@o0.ingest.sentry.example.test/1",
    }),
    [],
  );
});

// Secreto TOTP base32 de 160 bits con pinta de aleatorio (como el de scripts/generateTotp.ts; no es de ningún sistema real).
const TOTP = "JBSWY3DPEHPK3PXPMZXW6YTBOI5HKQ2L";
const SUPERADMIN = { PANEL_SUPERADMIN_USERNAME: "root", PANEL_SUPERADMIN_HASH: "a1b2c3:d4e5f6" };

test("secretos: con superadmin configurado en producción, PANEL_SUPERADMIN_TOTP_SECRET es obligatorio", () => {
  const missing = prod(SUPERADMIN);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /PANEL_SUPERADMIN_TOTP_SECRET falta/);
  assert.match(missing[0], /generateTotp/);
  assert.match(prod({ ...SUPERADMIN, PANEL_SUPERADMIN_TOTP_SECRET: "   " })[0], /PANEL_SUPERADMIN_TOTP_SECRET falta/);
  assert.deepEqual(prod({ ...SUPERADMIN, PANEL_SUPERADMIN_TOTP_SECRET: TOTP }), []);
  // Fuera de producción sigue siendo opcional (desarrollo y tests).
  assert.deepEqual(productionSecretProblems({ ...SUPERADMIN }), []);
});

test("secretos: PANEL_SUPERADMIN_TOTP_SECRET inválido (no base32, corto, patrón o ejemplo) → problema sin repetir el valor", () => {
  const bad = (v: string) => prod({ ...SUPERADMIN, PANEL_SUPERADMIN_TOTP_SECRET: v });
  assert.match(bad("no-es-base32-0189!")[0], /no es base32 válido/);
  assert.match(bad("JBSWY3DPEHPK3PXP")[0], /es corto/); // 80 bits: lo acepta el login, no producción
  assert.match(bad("A".repeat(32))[0], /poca entropía/);
  assert.match(bad("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")[0], /poca entropía/); // el vector público del RFC 6238
  assert.match(bad("cambiame")[0], /valor de ejemplo/);
  for (const v of ["no-es-base32-0189!", "JBSWY3DPEHPK3PXP"]) assert.ok(!bad(v)[0].includes(v), "el mensaje no repite el valor");
});

test("secretos: sin superadmin (o con el hash de ejemplo, que no deja entrar a nadie) no se exige el TOTP", () => {
  assert.deepEqual(prod({}), []);
  assert.deepEqual(prod({ PANEL_SUPERADMIN_USERNAME: "root" }), []);
  assert.deepEqual(prod({ PANEL_SUPERADMIN_HASH: "a1b2c3:d4e5f6" }), []);
  assert.deepEqual(prod({ PANEL_SUPERADMIN_USERNAME: "admin", PANEL_SUPERADMIN_HASH: envExampleValue("PANEL_SUPERADMIN_HASH")! }), []);
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
