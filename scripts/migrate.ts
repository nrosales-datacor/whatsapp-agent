import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// ─────────────────────────────────────────────────────────────────────────────
// Aplica las migraciones de ./drizzle a la base de DATABASE_URL.
// Usa la misma config que la app (SSL + prepare:false para el pooler de Supabase).
//   Ejecutar:  npx tsx scripts/migrate.ts
// ─────────────────────────────────────────────────────────────────────────────

// Con la app conectada como `app_runtime` (sin DDL ni BYPASSRLS), los scripts de
// operación usan la URL privilegiada. Sin ella (dev) cae a DATABASE_URL.
const url = process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL_MIGRATIONS (o DATABASE_URL) en el .env");
  process.exit(1);
}

const isSupabase = /supabase\.(co|com)/.test(url);
const sql = isSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

try {
  console.log("Conectando y aplicando migraciones…");
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  console.log("✅ Migraciones aplicadas. Tablas:");
  for (const t of tables) console.log("   •", t.table_name);
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  // Drizzle envuelve los errores de query: el motivo real de Postgres queda en `.cause`,
  // no en `.message` (que solo trae la query fallida + params).
  if (e instanceof Error && e.cause instanceof Error) {
    console.error("   causa:", e.cause.message);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
