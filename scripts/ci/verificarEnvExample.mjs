// Guardrail: toda variable de entorno que LEE el código de src/ o scripts/ tiene que estar
// documentada en .env.example. Sin esto, .env.example se desactualiza en silencio (llegó a
// faltar ~40 variables: STRIPE_*, PANEL_LOGIN_*, RATE_LIMIT_INGESTA_*, …) y quien levanta
// una instancia nueva no sabe qué existe ni qué default tiene.
//
// Detecta:
//   - process.env.<NOMBRE>  y  process.env[<"NOMBRE">]   (lecturas; las asignaciones
//     `process.env.<X> = …` y los `delete process.env.<X>` no cuentan: no son configuración)
//   - helpers de lectura con el nombre literal: msDeEnv(<"X">, …), enteroDeEnv(<"X">, …),
//     numeroDeEnv(<"X">, …), leerDelEnvReal(<"X">) — cualquier función cuyo nombre contenga "Env".
//
// Cuenta como documentada si .env.example tiene una línea `NOMBRE=` o comentada `# NOMBRE=`.
// Excepción explícita (variable que a propósito NO va en .env.example), en .env.example:
//   # env-check: ignorar NOMBRE — motivo
//
// Sin dependencias: solo Node. Uso (lo corre el CI):  node scripts/ci/verificarEnvExample.mjs

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const CARPETAS = ["src", "scripts"];
const EXTENSIONES = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);

// El lookahead impide que el backtracking recorte el nombre para esquivar el `(?!\s*=)`.
const NOMBRE = "[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])";
const PATRONES = [
  // Lectura de process.env.<X> que NO sea asignación (= pero no ==/===) ni esté precedido por `delete`.
  new RegExp(`(?<!delete\\s+)process\\.env\\.(${NOMBRE})(?!\\s*=(?!=))`, "g"),
  new RegExp(`(?<!delete\\s+)process\\.env\\[\\s*["'\`](${NOMBRE})["'\`]\\s*\\](?!\\s*=(?!=))`, "g"),
  new RegExp(`\\b\\w*Env\\w*\\(\\s*["'\`](${NOMBRE})["'\`]`, "g"),
];

function* archivos(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) yield* archivos(ruta);
    else if (EXTENSIONES.has(path.extname(e.name))) yield ruta;
  }
}

/** nombre → primer archivo:línea donde se lee. */
const leidas = new Map();
for (const carpeta of CARPETAS) {
  for (const archivo of archivos(path.join(RAIZ, carpeta))) {
    const lineas = readFileSync(archivo, "utf8").split(/\r?\n/);
    lineas.forEach((linea, i) => {
      for (const re of PATRONES) {
        for (const m of linea.matchAll(re)) {
          if (!leidas.has(m[1])) leidas.set(m[1], `${path.relative(RAIZ, archivo).replace(/\\/g, "/")}:${i + 1}`);
        }
      }
    });
  }
}

const envExample = readFileSync(path.join(RAIZ, ".env.example"), "utf8");
const documentadas = new Set();
const ignoradas = new Set();
for (const linea of envExample.split(/\r?\n/)) {
  const doc = linea.match(new RegExp(`^\\s*#?\\s*(${NOMBRE})=`));
  if (doc) documentadas.add(doc[1]);
  const exc = linea.match(new RegExp(`^\\s*#\\s*env-check:\\s*ignorar\\s+(${NOMBRE})\\b`));
  if (exc) ignoradas.add(exc[1]);
}

const faltan = [...leidas.entries()]
  .filter(([nombre]) => !documentadas.has(nombre) && !ignoradas.has(nombre))
  .sort(([a], [b]) => a.localeCompare(b));

if (faltan.length > 0) {
  console.error("Variables de entorno leídas por el código pero NO documentadas en .env.example:");
  for (const [nombre, donde] of faltan) console.error(`  - ${nombre}  (${donde})`);
  console.error(
    "Agregalas a .env.example (`NOMBRE=` o `# NOMBRE=valor-por-defecto` con un comentario de 1 línea),\n" +
      "o declaralas como excepción explícita: `# env-check: ignorar NOMBRE — motivo`.",
  );
  process.exit(1);
}
console.log(`OK: las ${leidas.size} variables de entorno leídas en ${CARPETAS.join("/ y ")}/ están en .env.example.`);
