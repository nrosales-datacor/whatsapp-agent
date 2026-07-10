import { crearDb } from "../db/client";

// Pool de Postgres propio del módulo de campañas (C3.2), independiente del `db`
// que arma server.ts para el repositorio/worker principal y del que arma
// src/config/tenantStore.ts para tenants/usuarios. Mismo precedente ya existente
// en el repo (varias piezas DB-directas fuera de la interfaz Repositorio, cada
// una con su propio lazy singleton).
let db: ReturnType<typeof crearDb> | null = null;

export function obtenerDb() {
  if (!db) db = crearDb();
  return db;
}
