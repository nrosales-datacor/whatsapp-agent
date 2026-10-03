// Guardrail de supply-chain (CLAUDE.md § "Política de dependencias"): toda dependencia
// directa se fija a una versión EXACTA. Un `^`/`~` (o `*`, `>=`, `latest`, `x`…) deja que
// `npm install` resuelva una versión nueva —quizá recién publicada y comprometida— sin que
// nadie la haya revisado. El lockfile protege a `npm ci`, pero no al próximo `npm install`.
//
// Sin dependencias: solo Node. Uso (lo corre el CI):  node scripts/ci/verificarVersionesExactas.mjs
// Sale con código 1 y lista cada violación si encuentra alguna.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const ARCHIVOS = ["package.json", "web/package.json"];
const SECCIONES = ["dependencies", "devDependencies", "optionalDependencies"];
// Versión semver exacta: 1.2.3 o 1.2.3-beta.1 (sin rangos, comodines ni tags).
const EXACTA = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const violaciones = [];
for (const archivo of ARCHIVOS) {
  const pkg = JSON.parse(readFileSync(RAIZ + archivo, "utf8"));
  for (const seccion of SECCIONES) {
    for (const [nombre, version] of Object.entries(pkg[seccion] ?? {})) {
      if (!EXACTA.test(version)) violaciones.push(`${archivo} → ${seccion}.${nombre}: "${version}"`);
    }
  }
}

if (violaciones.length > 0) {
  console.error("Dependencias sin versión exacta (quitá ^/~/rangos; fijá la que resuelve el lockfile, ver `npm ls`):");
  for (const v of violaciones) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`OK: todas las dependencias de ${ARCHIVOS.join(" y ")} tienen versión exacta.`);
