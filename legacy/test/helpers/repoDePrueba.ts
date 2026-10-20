import { after, afterEach } from "node:test";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { crearDbEfimera, type DbEfimera } from "./pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio de prueba: el MISMO RepositorioDrizzle de producción sobre un Postgres
// efímero (PGlite). Reemplaza al viejo repositorio en memoria, que era otra
// implementación de los datos y divergía de la real.
//
// Una sola base por archivo de tests (crear una cuesta ~1 s y ~100 MB de memoria WASM),
// vaciada con TRUNCATE después de cada test: cada test arranca con la base limpia.
// ─────────────────────────────────────────────────────────────────────────────

let base: Promise<DbEfimera> | null = null;
let usada = false;

afterEach(async () => {
  if (!base || !usada) return;
  usada = false;
  const { client } = await base;
  const { rows } = await client.query<{ t: string }>(
    "SELECT string_agg(format('%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows[0]?.t) await client.exec(`TRUNCATE ${rows[0].t} CASCADE`);
});

after(async () => {
  if (base) await (await base).cerrar();
  base = null;
});

export type RepoDePrueba = RepositorioDrizzle & { base: DbEfimera["db"] };

export async function repoDePrueba(): Promise<RepoDePrueba> {
  base ??= crearDbEfimera();
  usada = true;
  const { db } = await base;
  return Object.assign(new RepositorioDrizzle(db), { base: db });
}
