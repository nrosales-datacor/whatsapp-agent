import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "../../src/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Postgres EFÍMERO in-process para los tests de fiabilidad (ángulo 5 de
// TESTING.md). PGlite es Postgres real compilado a WASM: corre sin servidor ni
// Docker, así que la suite de fiabilidad corre en cada push (y localmente) sobre
// el MISMO SQL que producción (FOR UPDATE SKIP LOCKED, CAS de recordatorios,
// backoff, reaper) — no una reimplementación en memoria.
//
// Cada llamada crea una base nueva y le aplica las migraciones reales de
// ./drizzle, igual que el deploy. Se descarta al terminar (nada persiste).
//
// El cast a `PostgresJsDatabase` es seguro en runtime: las colas tipan su `db`
// contra el driver de producción (postgres.js), pero los métodos que usan
// (`execute`, `transaction`, `insert/update/select`) existen idénticos en el
// driver PGlite. `src/db/filas.ts` absorbe la única diferencia de forma (el
// resultado del SQL crudo: arreglo vs `{ rows }`).
// ─────────────────────────────────────────────────────────────────────────────

export interface DbEfimera {
  db: PostgresJsDatabase<typeof schema>;
  cerrar: () => Promise<void>;
}

export async function crearDbEfimera(): Promise<DbEfimera> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return {
    db: db as unknown as PostgresJsDatabase<typeof schema>,
    cerrar: () => client.close(),
  };
}
