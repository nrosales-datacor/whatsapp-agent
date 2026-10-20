// Descarga (una sola vez) los .woff2 de las fuentes del panel desde Google Fonts
// y los guarda en src/platform/http/fonts/ para SERVIRLOS NOSOTROS (sin depender del CDN
// de Google en runtime: funciona offline y detrás de firewalls corporativos).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/platform/http/fonts");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap";

const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");

const css = await (await fetch(CSS_URL, { headers: { "User-Agent": UA } })).text();

// Cada bloque viene precedido por un comentario de subset: /* latin */, /* latin-ext */, etc.
const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
const wanted = []; // { family, weight, url, name }
let m;
while ((m = re.exec(css))) {
  const subset = m[1];
  if (subset !== "latin") continue; // latin cubre español (acentos, ñ, ¿, ¡)
  const body = m[2];
  const family = (body.match(/font-family:\s*'([^']+)'/) || [])[1];
  const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1];
  const url = (body.match(/src:\s*url\(([^)]+)\)/) || [])[1];
  if (!family || !weight || !url) continue;
  wanted.push({ family, weight, url, name: `${slug(family)}-${weight}.woff2` });
}

console.log(`Encontradas ${wanted.length} variantes latin.`);
for (const f of wanted) {
  const buf = Buffer.from(await (await fetch(f.url, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(resolve(OUT, f.name), buf);
  console.log(`  ${f.name}  (${f.family} ${f.weight}, ${(buf.length / 1024).toFixed(1)} KB)`);
}
console.log(`\nGuardadas en ${OUT}`);
