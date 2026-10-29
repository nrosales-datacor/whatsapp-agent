import { execFileSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail de migraciones — LA TRAMPA CONOCIDA.
//
// Cambiar un `schema.ts` (src/platform/**/schema.ts o src/modules/**/schema.ts, ver
// drizzle.config.ts) SIN generar la migración correspondiente rompe el deploy en
// silencio: `migrate.ts` aplica solo las migraciones existentes y la base queda distinta
// al código.
//
// Este script detecta ese drift sin tocar ninguna base: corre `drizzle-kit generate`
// (que compara los esquemas contra el estado acumulado de ./drizzle usando los snapshots
// de ./drizzle/meta, offline — no necesita DATABASE_URL) y falla si eso PRODUCE cambios
// en ./drizzle. Si genera algo, es que hay cambios de esquema sin migrar.
//
// Corre en CI en cada push (ver .github/workflows/ci-cd.yml). Deja el árbol como lo
// encontró: cualquier archivo que `generate` haya creado/modificado se revierte.
// ─────────────────────────────────────────────────────────────────────────────

const FOLDER = "drizzle";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Igual que git() pero SIN recortar: preserva la alineación de columnas del
// `--porcelain` (los 2 primeros chars son el estado, el path arranca en el 4to).
function gitRaw(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

// Estado de ./drizzle ANTES de generar: si ya estaba sucio (cambios sin commitear), no se
// puede distinguir el drift de lo que el dev tenía a medias — avisamos y salimos.
const dirtyBefore = git("status", "--porcelain", "--", FOLDER);
if (dirtyBefore) {
  console.error(
    `⚠️  ${FOLDER}/ tiene cambios sin commitear; no puedo verificar el drift de forma confiable.\n` +
      "Commiteá o descartá esos cambios y volvé a correr `npm run db:check`.\n\n" +
      dirtyBefore,
  );
  process.exit(1);
}

console.log("Corriendo `drizzle-kit generate` para detectar drift de esquema…");
try {
  execFileSync("npx", ["drizzle-kit", "generate"], { encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" });
} catch (e) {
  console.error("❌ `drizzle-kit generate` falló:", e instanceof Error ? e.message : e);
  process.exit(1);
}

const dirtyAfter = git("status", "--porcelain", "--", FOLDER);
if (!dirtyAfter) {
  console.log("✅ Sin drift: los esquemas están en sync con las migraciones de ./drizzle.");
  process.exit(0);
}

// Hubo drift. Revertimos lo que generate tocó para no ensuciar el árbol, y fallamos con
// instrucciones claras.
console.error(
  "❌ DRIFT DETECTADO: `drizzle-kit generate` produjo cambios en ./drizzle.\n" +
    "   Eso significa que un schema.ts cambió SIN su migración. Si esto llega a\n" +
    "   producción, el deploy deja la base distinta al código.\n\n" +
    "   Arreglalo así:  npm run db:generate   (y commiteá la migración nueva)\n\n" +
    "   Archivos que generate tocó:",
);
for (const line of dirtyAfter.split("\n")) console.error("     " + line);

// Restaurar el árbol: descartar modificaciones a archivos trackeados y borrar los nuevos.
// Se parsea la salida SIN recortar para no desalinear las columnas.
for (const line of gitRaw("status", "--porcelain", "--", FOLDER).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const status = line.slice(0, 2);
  const file = line.slice(3).trim().replace(/^"|"$/g, "");
  if (status.includes("?")) {
    // Untracked (lo creó generate): borrarlo.
    try {
      execFileSync("git", ["clean", "-fq", "--", file]);
    } catch {
      /* best-effort */
    }
  } else {
    try {
      git("checkout", "--", file);
    } catch {
      /* best-effort */
    }
  }
}

process.exit(1);
