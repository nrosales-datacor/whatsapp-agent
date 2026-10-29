import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/platform/db/scope";
import { MIGRATIONS_FOLDER } from "../../src/platform/db/client";
import { schema } from "../../src/platform/db/schemaRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// Postgres EFÍMERO in-process para los tests. PGlite es Postgres real compilado a WASM:
// corre sin servidor ni Docker, sobre el MISMO SQL que producción (FOR UPDATE SKIP
// LOCKED, RLS, roles, btree_gist) — no una reimplementación en memoria.
//
// Velocidad: crear una base con `new PGlite()` corre initdb (varios segundos) y después
// hay que aplicar las migraciones. En vez de pagar eso por cada test, se migra UNA vez una
// plantilla, se vuelca su data dir y cada base nueva se carga desde ese volcado. El
// volcado se cachea además en disco (tmpdir), con una clave que cambia si cambia
// cualquier migración o la versión de PGlite: los procesos de test que corren en
// paralelo (uno por archivo) no repiten initdb + migraciones.
//
// El cast a `Db` (tipado contra postgres.js, el driver de producción) es seguro en
// runtime: los métodos que usa el código (`execute`, `transaction`,
// `insert/update/select`) existen idénticos en el driver PGlite.
// `src/platform/db/rows.ts` absorbe la única diferencia de forma (arreglo vs `{ rows }`).
// ─────────────────────────────────────────────────────────────────────────────

export interface EphemeralDb {
  db: Db;
  /** Cliente PGlite crudo (para tests que necesitan `SET ROLE` u otro SQL de sesión). */
  client: PGlite;
  close: () => Promise<void>;
}

// btree_gist viene aparte en PGlite (contrib): hay que cargarlo en cada cliente, también
// en los que se crean desde el volcado de la plantilla.
const EXTENSIONS = { btree_gist };

function templateKey(): string {
  const h = createHash("sha256");
  const version = JSON.parse(readFileSync("node_modules/@electric-sql/pglite/package.json", "utf8")).version;
  h.update(`pglite@${version}`);
  for (const sub of ["", "meta"]) {
    const dir = join(MIGRATIONS_FOLDER, sub);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".sql") && !f.endsWith(".json")) continue;
      h.update(`${sub}/${f}`);
      h.update(readFileSync(join(dir, f)));
    }
  }
  return h.digest("hex").slice(0, 16);
}

let template: Promise<Blob> | null = null;

function getTemplate(): Promise<Blob> {
  template ??= (async () => {
    const file = join(tmpdir(), `selyon-pglite-${templateKey()}.tar`);
    try {
      return new Blob([await readFile(file)]);
    } catch {
      // no hay caché en disco todavía: se arma abajo
    }
    const client = new PGlite({ extensions: EXTENSIONS });
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    const dump = await client.dumpDataDir("none");
    await client.close();
    // Escritura atómica (tmp + rename): otro proceso de test puede estar leyendo.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, Buffer.from(await dump.arrayBuffer()));
    await rename(tmp, file).catch(() => {});
    return dump;
  })();
  return template;
}

export async function createEphemeralDb(): Promise<EphemeralDb> {
  const client = new PGlite({ loadDataDir: await getTemplate(), extensions: EXTENSIONS });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    client,
    close: () => client.close(),
  };
}
