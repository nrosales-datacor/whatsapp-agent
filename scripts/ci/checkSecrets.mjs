// Guardrail de CI: que no se vuelva a commitear una credencial. Recorre los archivos
// versionados (`git ls-files`) —o los que se le pasen como argumentos— y falla si encuentra:
//
//   1. Patrones de llaves conocidas: Stripe (sk_live_/rk_live_, sk_test_, whsec_), tokens
//      de Meta (EAA…), llaves privadas PEM, OpenAI (sk-…), GitHub (ghp_…), AWS (AKIA…),
//      Google API (AIza…), webhooks de Slack, tokens de bot de Telegram (123…:AA…), JWT
//      completos (eyJ….eyJ….firma).
//   2. URLs de Postgres con usuario:clave@ cuya clave no sea un placeholder evidente
//      (pass, clave, TU_PASSWORD, ..., <x>, ${X}) ni apunte a localhost.
//   3. Una contraseña en texto plano en la documentación (.md): `contraseña \`valor\``.
//   4. Cadenas prohibidas (p. ej. contraseñas que ya se filtraron). La lista NO vive en el
//      repo —publicarla sería volver a filtrarlas—: sale de la variable CHECK_SECRETS_DENYLIST
//      (una por línea; en CI es un secret de GitHub) y del archivo local, gitignoreado,
//      `.secrets-denylist`. Se comparan sin distinguir mayúsculas.
//
// Allowlist: solo por archivo y por regla (ALLOW, abajo) — p. ej. el ejemplo de llave PEM
// vacía de .env.example. No hay marcas "ignorar esta línea": una llave real nunca se
// permite, se rota y se saca.
//
// Los hallazgos se reportan con archivo:línea y la regla, y el valor ENMASCARADO (nunca se
// imprime entero: el log del CI es público).
//
// Sin dependencias: solo Node. Uso (lo corre el CI):
//   node scripts/ci/checkSecrets.mjs              → archivos versionados
//   node scripts/ci/checkSecrets.mjs a.txt dir/   → solo esos (los tests lo usan así)
// Sale con código 1 y lista cada hallazgo si encuentra alguno.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024;

/** Reglas por patrón. `test(match)` opcional: false = no es hallazgo (placeholder). */
const RULES = [
  { id: "stripe-live", label: "llave live de Stripe", re: /\b[sr]k_live_[0-9A-Za-z]{10,}/g },
  { id: "stripe-test", label: "llave de prueba de Stripe", re: /\bsk_test_[0-9A-Za-z]{20,}/g },
  { id: "stripe-webhook", label: "secreto de webhook de Stripe", re: /\bwhsec_[0-9A-Za-z+/=]{20,}/g },
  { id: "meta-token", label: "token de Meta / WhatsApp", re: /\bEAA[0-9A-Za-z]{40,}/g },
  { id: "private-key", label: "llave privada PEM", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: "openai", label: "llave de OpenAI", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { id: "github-token", label: "token de GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { id: "aws-key", label: "access key de AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", label: "API key de Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Bot de Telegram de las alertas (ALERTS_TELEGRAM_BOT_TOKEN): "<id numérico>:AA<35>".
  { id: "telegram-bot-token", label: "token de bot de Telegram", re: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}(?![0-9A-Za-z_-])/g },
  {
    id: "slack-webhook",
    label: "webhook de Slack",
    re: /hooks\.slack\.com\/services\/T[0-9A-Z]{6,}\/B[0-9A-Z]{6,}\/[0-9A-Za-z]{20,}/g,
  },
  { id: "jwt", label: "JWT completo", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g },
  {
    id: "postgres-url",
    label: "URL de Postgres con clave",
    re: /\bpostgres(?:ql)?:\/\/([^\s:/@'"`]+):([^\s@'"`]+)@([^\s/:'"`?]+)/gi,
    test: (m) => !isPlaceholderPassword(m[2]) && !isLocalHost(m[3]),
  },
];

/** Solo en Markdown: "contraseña `valor`" / password: "valor". */
const DOC_PASSWORD_RULE = {
  id: "doc-password",
  label: "contraseña en texto plano en la documentación",
  re: /(?:contraseña|password|passwd)\s*[:=]?\s*[`"']([^`"'\s]{6,})[`"']/gi,
  test: (m) => !isPlaceholderPassword(m[1]),
};

/** Allowlist por archivo (ruta relativa a la raíz, con /) → reglas permitidas en él. */
const ALLOW = {
  // El ejemplo comentado de GOOGLE_PRIVATE_KEY trae la cabecera PEM con el cuerpo vacío ("...").
  ".env.example": ["private-key"],
};

const PLACEHOLDER_PASSWORDS = new Set([
  "pass", "password", "passwd", "clave", "contraseña", "secret", "secreto", "postgres",
  "changeme", "cambiame", "user", "usuario", "admin", "test", "prueba",
]);

function isPlaceholderPassword(value) {
  const v = value.trim();
  if (PLACEHOLDER_PASSWORDS.has(v.toLowerCase())) return true;
  if (/^[.…*xX]+$/.test(v)) return true; // ..., ***, xxxx
  if (/[<>${}\[\]…]/.test(v)) return true; // <clave>, ${PGPASSWORD}, [CLAVE]
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return true; // TU_PASSWORD, CLAVE, UNA_CLAVE_FUERTE
  return false;
}

function isLocalHost(host) {
  return /^(localhost|127\.\d+\.\d+\.\d+|::1|host)$/i.test(host);
}

/** Valor enmascarado para el reporte: primeros 4 caracteres + largo. */
function mask(value) {
  return `${value.slice(0, 4)}… (${value.length} caracteres)`;
}

function loadDenylist() {
  const lines = [];
  if (process.env.CHECK_SECRETS_DENYLIST) lines.push(...process.env.CHECK_SECRETS_DENYLIST.split(/\r?\n/));
  const file = path.join(ROOT, ".secrets-denylist");
  if (existsSync(file)) lines.push(...readFileSync(file, "utf8").split(/\r?\n/));
  return [...new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.toLowerCase()))];
}

function listTracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).map((f) => path.join(ROOT, f));
}

function expand(target) {
  const abs = path.resolve(target);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules" || d.name === ".git" ? [] : expand(path.join(abs, d.name)),
  );
}

function relative(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

export function scanText(text, rel, denylist = []) {
  const findings = [];
  const allowed = new Set(ALLOW[rel] ?? []);
  const rules = rel.toLowerCase().endsWith(".md") ? [...RULES, DOC_PASSWORD_RULE] : RULES;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (allowed.has(rule.id)) continue;
      for (const m of line.matchAll(rule.re)) {
        if (rule.test && !rule.test(m)) continue;
        findings.push({ file: rel, line: i + 1, rule: rule.label, sample: mask(m[0]) });
      }
    }
    if (denylist.length > 0) {
      const lower = line.toLowerCase();
      for (const bad of denylist) {
        if (lower.includes(bad)) findings.push({ file: rel, line: i + 1, rule: "cadena prohibida (denylist)", sample: `(${bad.length} caracteres)` });
      }
    }
  });
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.flatMap(expand) : listTracked();
  const denylist = loadDenylist();
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (!existsSync(file)) continue; // borrado en el árbol de trabajo
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binario
    scanned++;
    findings.push(...scanText(buf.toString("utf8"), relative(file), denylist));
  }
  if (findings.length > 0) {
    console.error(`Posibles secretos en el repo (${findings.length}). Sacalos, rotá la credencial y usá .env / secrets de GitHub:`);
    for (const f of findings) console.error(`  - ${f.file}:${f.line} → ${f.rule}: ${f.sample}`);
    process.exit(1);
  }
  const extra = denylist.length > 0 ? ` y ${denylist.length} cadena(s) prohibida(s)` : "";
  console.log(`OK: ${scanned} archivo(s) revisados sin patrones de llaves${extra}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
