import { crearDb } from "../db/client";

// Pool de Postgres propio del módulo de rescate (Carril D, 1.1), independiente del
// `db` que arma server.ts para el repositorio/worker principal — mismo precedente
// que src/campaigns/db.ts (ver [[patron-colas-independientes]]).
let db: ReturnType<typeof crearDb> | null = null;

export function obtenerDb() {
  if (!db) db = crearDb();
  return db;
}
