import { execFileSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail de migraciones (ángulo 7 de TESTING.md) — LA TRAMPA CONOCIDA.
//
// Cambiar src/db/schema.ts SIN generar la migración drizzle correspondiente rompe
// TODO el deploy en silencio: `migrar.ts` aplica solo las migraciones existentes,
// la base queda distinta a schema.ts y `seedTenants` aborta ANTES del pm2 restart.
//
// Este script detecta ese drift sin tocar ninguna base: corre `drizzle-kit generate`
// (que compara schema.ts contra el estado acumulado de ./drizzle usando los snapshots
// de ./drizzle/meta, offline — no necesita DATABASE_URL) y falla si eso PRODUCE
// cambios en ./drizzle. Si genera algo, es que schema.ts tiene cambios sin migrar.
//
// Corre en CI en cada push (ver .github/workflows/ci-cd.yml). Deja el árbol como lo
// encontró: cualquier archivo que `generate` haya creado/modificado se revierte.
// ─────────────────────────────────────────────────────────────────────────────

const CARPETA = "drizzle";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Igual que git() pero SIN recortar: preserva la alineación de columnas del
// `--porcelain` (los 2 primeros chars son el estado, el path arranca en el 4to).
// Recortar borraría el espacio inicial de la 1ª línea y desalinearía el parseo.
function gitRaw(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

// Estado de ./drizzle ANTES de generar: si ya estaba sucio (cambios sin commitear),
// no podemos distinguir el drift de lo que el dev tenía a medias — avisamos y salimos.
const sucioPrevio = git("status", "--porcelain", "--", CARPETA);
if (sucioPrevio) {
  console.error(
    `⚠️  ${CARPETA}/ tiene cambios sin commitear; no puedo verificar el drift de forma confiable.\n` +
      "Commiteá o descartá esos cambios y volvé a correr `npm run db:check`.\n\n" +
      sucioPrevio,
  );
  process.exit(1);
}

console.log("Corriendo `drizzle-kit generate` para detectar drift de schema…");
try {
  execFileSync("npx", ["drizzle-kit", "generate"], { encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" });
} catch (e) {
  console.error("❌ `drizzle-kit generate` falló:", e instanceof Error ? e.message : e);
  process.exit(1);
}

const sucioPost = git("status", "--porcelain", "--", CARPETA);
if (!sucioPost) {
  console.log("✅ Sin drift: schema.ts está en sync con las migraciones de ./drizzle.");
  process.exit(0);
}

// Hubo drift. Revertimos lo que generate tocó para no ensuciar el árbol, y fallamos
// con instrucciones claras.
console.error(
  "❌ DRIFT DETECTADO: `drizzle-kit generate` produjo cambios en ./drizzle.\n" +
    "   Eso significa que src/db/schema.ts cambió SIN su migración. Si esto llega a\n" +
    "   producción, el deploy se rompe en silencio (seedTenants aborta antes del restart).\n\n" +
    "   Arreglalo así:  npm run db:generate   (y commiteá la migración nueva)\n\n" +
    "   Archivos que generate tocó:",
);
for (const linea of sucioPost.split("\n")) console.error("     " + linea);

// Restaurar el árbol: descartar modificaciones a archivos trackeados y borrar los
// nuevos. Se parsea la salida SIN recortar para no desalinear las columnas.
for (const linea of gitRaw("status", "--porcelain", "--", CARPETA).split(/\r?\n/)) {
  if (!linea.trim()) continue;
  const estado = linea.slice(0, 2);
  const archivo = linea.slice(3).trim().replace(/^"|"$/g, "");
  if (estado.includes("?")) {
    // Untracked (lo creó generate): borrarlo.
    try {
      execFileSync("git", ["clean", "-fq", "--", archivo]);
    } catch {
      /* best-effort */
    }
  } else {
    try {
      git("checkout", "--", archivo);
    } catch {
      /* best-effort */
    }
  }
}

process.exit(1);
