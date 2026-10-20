// Guardrail: toda variable de entorno que LEE el código de src/ o scripts/ tiene que estar
// documentada en .env.example. Sin esto, .env.example se desactualiza en silencio y quien
// levanta una instancia nueva no sabe qué existe ni qué default tiene. La carpeta legacy/
// (dominio viejo, fuera del build) no se recorre.
//
// Detecta:
//   - process.env.<NOMBRE>  y  process.env[<"NOMBRE">]   (lecturas; las asignaciones
//     `process.env.<X> = …` y los `delete process.env.<X>` no cuentan: no son configuración)
//   - helpers de lectura con el nombre literal: msFromEnv(<"X">, …) — cualquier función cuyo
//     nombre contenga "Env".
//
// Cuenta como documentada si .env.example tiene una línea `NOMBRE=` o comentada `# NOMBRE=`.
// Excepción explícita (variable que a propósito NO va en .env.example), en .env.example:
//   # env-check: ignore NOMBRE — motivo
//
// Sin dependencias: solo Node. Uso (lo corre el CI):  node scripts/ci/checkEnvExample.mjs

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FOLDERS = ["src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);

// El lookahead impide que el backtracking recorte el nombre para esquivar el `(?!\s*=)`.
const NAME = "[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])";
const PATTERNS = [
  // Lectura de process.env.<X> que NO sea asignación (= pero no ==/===) ni esté precedido por `delete`.
  new RegExp(`(?<!delete\\s+)process\\.env\\.(${NAME})(?!\\s*=(?!=))`, "g"),
  new RegExp(`(?<!delete\\s+)process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\](?!\\s*=(?!=))`, "g"),
  new RegExp(`\\b\\w*Env\\w*\\(\\s*["'\`](${NAME})["'\`]`, "g"),
];

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (EXTENSIONS.has(path.extname(e.name))) yield p;
  }
}

/** nombre → primer archivo:línea donde se lee. */
const read = new Map();
for (const folder of FOLDERS) {
  for (const file of files(path.join(ROOT, folder))) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of PATTERNS) {
        for (const m of line.matchAll(re)) {
          if (!read.has(m[1])) read.set(m[1], `${path.relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}`);
        }
      }
    });
  }
}

const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");
const documented = new Set();
const ignored = new Set();
for (const line of envExample.split(/\r?\n/)) {
  const doc = line.match(new RegExp(`^\\s*#?\\s*(${NAME})=`));
  if (doc) documented.add(doc[1]);
  const exc = line.match(new RegExp(`^\\s*#\\s*env-check:\\s*ignore\\s+(${NAME})\\b`));
  if (exc) ignored.add(exc[1]);
}

const missing = [...read.entries()]
  .filter(([name]) => !documented.has(name) && !ignored.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length > 0) {
  console.error("Variables de entorno leídas por el código pero NO documentadas en .env.example:");
  for (const [name, where] of missing) console.error(`  - ${name}  (${where})`);
  console.error(
    "Agregalas a .env.example (`NOMBRE=` o `# NOMBRE=valor-por-defecto` con un comentario de 1 línea),\n" +
      "o declaralas como excepción explícita: `# env-check: ignore NOMBRE — motivo`.",
  );
  process.exit(1);
}
console.log(`OK: las ${read.size} variables de entorno leídas en ${FOLDERS.join("/ y ")}/ están en .env.example.`);
