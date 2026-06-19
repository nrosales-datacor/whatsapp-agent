import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

// Crea el cliente Drizzle a partir de DATABASE_URL.
// Solo se invoca cuando hay una base de datos configurada.
//
// Para Supabase se activan dos cosas automáticamente:
//   • ssl: "require"  → Supabase exige conexión cifrada.
//   • prepare: false  → necesario si se usa el pooler en modo transacción
//     (puerto 6543); es inofensivo en conexión directa/sesión.
export function crearDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Falta DATABASE_URL para conectar a PostgreSQL");
  const esSupabase = /supabase\.(co|com)/.test(url);
  const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false }) : postgres(url);
  return drizzle(sql, { schema });
}
