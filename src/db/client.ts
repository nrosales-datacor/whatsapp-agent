import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

// Crea el cliente Drizzle a partir de DATABASE_URL.
// Solo se invoca cuando hay una base de datos configurada.
export function crearDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Falta DATABASE_URL para conectar a PostgreSQL");
  const sql = postgres(url);
  return drizzle(sql, { schema });
}
