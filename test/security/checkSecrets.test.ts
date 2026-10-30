import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail de CI contra secretos commiteados (scripts/ci/checkSecrets.mjs, `npm run
// ci:secrets` en el job verify). Se corre el script real sobre archivos temporales.
// Las llaves falsas se ARMAN en tiempo de ejecución (concatenando) para que este mismo
// archivo no dispare el escaneo del repo.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = path.resolve("scripts/ci/checkSecrets.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "check-secrets-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function scan(name: string, content: string, env: Record<string, string> = {}) {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return spawnSync(process.execPath, [SCRIPT, file], {
    encoding: "utf8",
    env: { ...process.env, CHECK_SECRETS_DENYLIST: "", ...env },
  });
}

const alnum = (n: number) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(4).slice(0, n);

const KEYS: Array<[string, string]> = [
  ["llave live de Stripe", "sk" + "_live_" + alnum(24)],
  ["llave de prueba de Stripe", "sk" + "_test_" + alnum(24)],
  ["secreto de webhook de Stripe", "wh" + "sec_" + alnum(32)],
  ["token de Meta / WhatsApp", "EA" + "A" + alnum(60)],
  ["llave privada PEM", "-----BEGIN RSA " + "PRIVATE KEY-----"],
  ["llave de OpenAI", "sk" + "-proj-" + alnum(40)],
  ["token de GitHub", "gh" + "p_" + alnum(36)],
  ["JWT completo", "ey" + "J" + alnum(20) + ".ey" + "J" + alnum(20) + "." + alnum(30)],
  ["URL de Postgres con clave", "postgres" + "ql://postgres:" + alnum(18) + "@db.abcdefgh.supabase.co:5432/postgres"],
];

for (const [rule, key] of KEYS) {
  test(`checkSecrets: detecta ${rule} y no imprime el valor entero`, () => {
    const r = scan("config.ts", `export const x = "${key}";\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(rule.replace(/[/.]/g, "\\$&")));
    assert.ok(!r.stderr.includes(key), "el log del CI es público: el valor sale enmascarado");
  });
}

test("checkSecrets: placeholders de ejemplo NO son hallazgo", () => {
  const ok = scan(
    "ejemplo.ts",
    [
      "# STRIPE_SECRET_KEY=sk_live_…",
      "# STRIPE_WEBHOOK_SECRET=whsec_…",
      "# DATABASE_URL=postgresql://user:pass@localhost:5432/db",
      "# BACKUP_DATABASE_URL=postgresql://postgres:TU_PASSWORD@db.xxxx.supabase.co:5432/postgres",
      'psql "postgresql://app_runtime.<ref>:CLAVE@<pooler>:5432/postgres"',
      "const FAKE_URL = \"postgres://usuario:clave@localhost:5432/prueba\";",
      "# ALERTS_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ",
    ].join("\n"),
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^OK:/);
});

test("checkSecrets: contraseña en texto plano en un .md → hallazgo; placeholder → no", () => {
  const bad = scan("guia.md", "Usuario `demo`, contraseña `" + "Zq8" + "w-ruta-77` (cambiala).\n");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /contraseña en texto plano/);
  const ok = scan("guia2.md", 'Generá el hash: `hashPassword.ts "UNA_CLAVE_FUERTE"`; la contraseña se la pedís a Nathan.\n');
  assert.equal(ok.status, 0, ok.stderr);
});

test("checkSecrets: cadenas prohibidas por CHECK_SECRETS_DENYLIST (sin mayúsculas, sin imprimirlas)", () => {
  const forbidden = "valor-" + "filtrado-" + "42";
  const r = scan("notas.txt", `la vieja era ${forbidden.toUpperCase()} y ya no\n`, { CHECK_SECRETS_DENYLIST: `# comentario\n${forbidden}\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cadena prohibida/);
  assert.ok(!r.stderr.toLowerCase().includes(forbidden));
  assert.equal(scan("notas2.txt", "nada que ver\n", { CHECK_SECRETS_DENYLIST: forbidden }).status, 0);
});

test("checkSecrets: el árbol versionado del repo está limpio", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, CHECK_SECRETS_DENYLIST: "" } });
  assert.equal(r.status, 0, r.stderr);
});
