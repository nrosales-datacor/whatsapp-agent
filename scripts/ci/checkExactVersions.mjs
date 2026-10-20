// Guardrail de supply-chain (CLAUDE.md § "Política de dependencias"): toda dependencia
// directa se fija a una versión EXACTA. Un `^`/`~` (o `*`, `>=`, `latest`, `x`…) deja que
// `npm install` resuelva una versión nueva —quizá recién publicada y comprometida— sin que
// nadie la haya revisado. El lockfile protege a `npm ci`, pero no al próximo `npm install`.
//
// Sin dependencias: solo Node. Uso (lo corre el CI):  node scripts/ci/checkExactVersions.mjs
// Sale con código 1 y lista cada violación si encuentra alguna.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILES = ["package.json", "web/package.json"];
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
// Versión semver exacta: 1.2.3 o 1.2.3-beta.1 (sin rangos, comodines ni tags).
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const violations = [];
for (const file of FILES) {
  const pkg = JSON.parse(readFileSync(ROOT + file, "utf8"));
  for (const section of SECTIONS) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (!EXACT.test(version)) violations.push(`${file} → ${section}.${name}: "${version}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("Dependencias sin versión exacta (quitá ^/~/rangos; fijá la que resuelve el lockfile, ver `npm ls`):");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`OK: todas las dependencias de ${FILES.join(" y ")} tienen versión exacta.`);
