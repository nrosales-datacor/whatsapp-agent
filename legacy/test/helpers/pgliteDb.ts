import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "../../src/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Postgres EFÍMERO in-process para los tests (ángulo 5 de TESTING.md). PGlite es
// Postgres real compilado a WASM: corre sin servidor ni Docker, sobre el MISMO SQL
// que producción (FOR UPDATE SKIP LOCKED, advisory locks, RLS) — no una
// reimplementación en memoria.
//
// Velocidad: crear una base con `new PGlite()` corre initdb (~5 s) y después hay que
// aplicar las migraciones. En vez de pagar eso por cada test, se migra UNA vez una
// plantilla, se vuelca su data dir y cada base nueva se carga desde ese volcado (~1 s).
// El volcado se cachea además en disco (tmpdir), con una clave que cambia si cambia
// cualquier migración o la versión de PGlite: los procesos de test que corren en
// paralelo (uno por archivo) no repiten initdb + migraciones.
//
// El cast a `PostgresJsDatabase` es seguro en runtime: las colas tipan su `db` contra
// el driver de producción (postgres.js), pero los métodos que usan (`execute`,
// `transaction`, `insert/update/select`) existen idénticos en el driver PGlite.
// `src/db/filas.ts` absorbe la única diferencia de forma (arreglo vs `{ rows }`).
// ─────────────────────────────────────────────────────────────────────────────

export interface DbEfimera {
  db: PostgresJsDatabase<typeof schema>;
  /** Cliente PGlite crudo (para tests que necesitan `SET ROLE` u otro SQL de sesión). */
  client: PGlite;
  cerrar: () => Promise<void>;
}

const CARPETA_MIGRACIONES = "./drizzle";

function claveDePlantilla(): string {
  const h = createHash("sha256");
  const version = JSON.parse(readFileSync("node_modules/@electric-sql/pglite/package.json", "utf8")).version;
  h.update(`pglite@${version}`);
  for (const sub of ["", "meta"]) {
    const dir = join(CARPETA_MIGRACIONES, sub);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".sql") && !f.endsWith(".json")) continue;
      h.update(`${sub}/${f}`);
      h.update(readFileSync(join(dir, f)));
    }
  }
  return h.digest("hex").slice(0, 16);
}

let plantilla: Promise<Blob> | null = null;

function obtenerPlantilla(): Promise<Blob> {
  plantilla ??= (async () => {
    const ruta = join(tmpdir(), `wa-pglite-${claveDePlantilla()}.tar`);
    try {
      return new Blob([await readFile(ruta)]);
    } catch {
      // no hay caché en disco todavía: se arma abajo
    }
    const client = new PGlite();
    await migrate(drizzle(client, { schema }), { migrationsFolder: CARPETA_MIGRACIONES });
    const volcado = await client.dumpDataDir("none");
    await client.close();
    // Escritura atómica (tmp + rename): otro proceso de test puede estar leyendo.
    const tmp = `${ruta}.${process.pid}.tmp`;
    await writeFile(tmp, Buffer.from(await volcado.arrayBuffer()));
    await rename(tmp, ruta).catch(() => {});
    return volcado;
  })();
  return plantilla;
}

export async function crearDbEfimera(): Promise<DbEfimera> {
  const client = new PGlite({ loadDataDir: await obtenerPlantilla() });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as PostgresJsDatabase<typeof schema>,
    client,
    cerrar: () => client.close(),
  };
}
