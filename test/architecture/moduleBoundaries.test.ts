import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// Fronteras entre módulos (PLAN-GESTION.md §2, "Reglas de dependencia"). Igual que
// test/security/rls.test.ts con RLS: una dependencia prohibida rompe acá, no queda
// escondida hasta que alguien la note en una revisión.
//
//   (a) El núcleo (business, team, catalog, clients, scheduling, sales, commissions,
//       reports) no importa nada de whatsapp, campaigns, billing ni onboarding.
//   (b) src/platform no importa de src/modules, salvo src/platform/db/schemaRegistry.ts
//       (junta los esquemas para el cliente de Drizzle).
//   (c) Un módulo importa de otro SOLO por su index.ts (su API pública). Única excepción:
//       el schema.ts de un módulo puede importar el schema.ts de otro, porque una FK de
//       Drizzle necesita el objeto de la tabla referenciada. Con eso, ninguna otra pieza
//       de un módulo puede leer las tablas de otro.
//   (d) Nadie depende de reports (I5): arma sus reportes con lo que exponen los demás y
//       solo la composición (src/routes.ts) lo usa. Así ningún módulo puede formar un
//       ciclo a través de él, y reports (núcleo de gestión) tampoco importa whatsapp,
//       billing ni onboarding (regla a).
//
// Los imports se leen con el preprocesador de TypeScript (no con una regex): ve imports,
// re-exports, `import type` e `import()` dinámicos, e ignora los comentarios.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const CORE = ["business", "team", "catalog", "clients", "scheduling", "sales", "commissions", "reports"];
/** Módulos de los que ningún otro módulo puede depender (solo la composición). */
const LEAVES = ["reports"];
const OUTSIDE_CORE = ["whatsapp", "campaigns", "billing", "onboarding"];
const SCHEMA_REGISTRY = "platform/db/schemaRegistry.ts";

/** Ruta relativa a src/ con barras normales, p. ej. "modules/scheduling/schema.ts". */
type SrcPath = string;

function moduleOf(p: SrcPath): string | null {
  const m = /^modules\/([^/]+)\//.exec(p);
  return m ? m[1] : null;
}

/** Reglas para un import de `from` a `to` (ambos dentro de src/). Devuelve las violaciones. */
function violations(from: SrcPath, to: SrcPath): string[] {
  const out: string[] = [];
  const fromModule = moduleOf(from);
  const toModule = moduleOf(to);
  if (fromModule && CORE.includes(fromModule) && toModule && OUTSIDE_CORE.includes(toModule)) {
    out.push(`(a) el núcleo no importa de ${toModule}: ${from} → ${to}`);
  }
  if (from.startsWith("platform/") && toModule && from !== SCHEMA_REGISTRY) {
    out.push(`(b) la plataforma no importa de src/modules: ${from} → ${to}`);
  }
  if (fromModule && toModule && fromModule !== toModule && LEAVES.includes(toModule)) {
    out.push(`(d) nadie depende de ${toModule} (solo la composición): ${from} → ${to}`);
  }
  if (fromModule && toModule && fromModule !== toModule) {
    const viaIndex = to === `modules/${toModule}/index.ts`;
    const schemaToSchema = from === `modules/${fromModule}/schema.ts` && to === `modules/${toModule}/schema.ts`;
    if (!viaIndex && !schemaToSchema) {
      out.push(`(c) ${fromModule} importa de ${toModule} sin pasar por su index.ts: ${from} → ${to}`);
    }
  }
  return out;
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

const toSrcPath = (abs: string): SrcPath => path.relative(SRC, abs).replace(/\\/g, "/");

/** Resuelve un especificador relativo a un archivo .ts dentro de src/ (null si es un paquete o queda afuera). */
function resolveImport(fromAbs: string, specifier: string): SrcPath | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      const rel = toSrcPath(c);
      return rel.startsWith("..") ? null : rel;
    }
  }
  throw new Error(`no se pudo resolver el import "${specifier}" de ${toSrcPath(fromAbs)}`);
}

interface ImportEdge {
  from: SrcPath;
  to: SrcPath;
}

function importEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of tsFiles(SRC)) {
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const imp of info.importedFiles) {
      const to = resolveImport(file, imp.fileName);
      if (to) edges.push({ from: toSrcPath(file), to });
    }
  }
  return edges;
}

test("fronteras: las reglas mismas (casos armados a mano)", () => {
  // (a)
  assert.equal(violations("modules/scheduling/service.ts", "modules/whatsapp/index.ts").length, 1);
  assert.equal(violations("modules/clients/schema.ts", "modules/campaigns/schema.ts").length, 1);
  assert.equal(violations("modules/sales/x.ts", "modules/billing/index.ts").length, 1);
  assert.deepEqual(violations("modules/whatsapp/agent.ts", "modules/scheduling/index.ts"), [], "el módulo whatsapp sí usa el núcleo");
  // (b)
  assert.equal(violations("platform/http/router.ts", "modules/team/index.ts").length, 1);
  assert.deepEqual(violations(SCHEMA_REGISTRY, "modules/team/schema.ts"), []);
  assert.deepEqual(violations("modules/team/schema.ts", "platform/db/rls.ts"), [], "los módulos sí usan la plataforma");
  // (c)
  assert.equal(violations("modules/scheduling/book.ts", "modules/catalog/schema.ts").length, 1, "leer tablas ajenas");
  assert.equal(violations("modules/scheduling/book.ts", "modules/catalog/pricing.ts").length, 1);
  assert.equal(violations("modules/scheduling/sub/schema.ts", "modules/catalog/schema.ts").length, 1, "solo el schema.ts raíz");
  assert.deepEqual(violations("modules/scheduling/book.ts", "modules/catalog/index.ts"), []);
  assert.deepEqual(violations("modules/scheduling/schema.ts", "modules/catalog/schema.ts"), [], "FK entre esquemas");
  assert.deepEqual(violations("modules/scheduling/book.ts", "modules/scheduling/schema.ts"), [], "dentro del mismo módulo");
  // (d)
  assert.equal(violations("modules/sales/totals.ts", "modules/reports/index.ts").length, 1, "nadie depende de reports");
  assert.deepEqual(violations("modules/reports/reports.ts", "modules/sales/index.ts"), [], "reports sí usa el núcleo");
  assert.deepEqual(violations("routes.ts", "modules/reports/index.ts"), [], "la composición sí");
  assert.equal(violations("modules/reports/home.ts", "modules/whatsapp/index.ts").length, 1, "reports no importa whatsapp");
});

test("fronteras: el escaneo de src/ ve los imports entre módulos (no es un test vacío)", () => {
  const edges = importEdges();
  const crossSchema = edges.filter((e) => {
    const a = moduleOf(e.from);
    const b = moduleOf(e.to);
    return a && b && a !== b;
  });
  assert.ok(
    crossSchema.some((e) => e.from === "modules/scheduling/schema.ts" && e.to === "modules/business/schema.ts"),
    "scheduling/schema.ts referencia businesses",
  );
  assert.ok(edges.some((e) => e.from === SCHEMA_REGISTRY && e.to === "modules/whatsapp/schema.ts"));
  for (const m of CORE) assert.ok(existsSync(path.join(SRC, "modules", m, "index.ts")), `modules/${m}/index.ts existe`);
});

test("fronteras: src/ respeta (a) núcleo sin whatsapp/campaigns/billing, (b) plataforma sin módulos, (c) solo por index.ts, (d) nadie depende de reports", () => {
  const problems = importEdges().flatMap((e) => violations(e.from, e.to));
  assert.deepEqual(problems, []);
});
