import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// ─────────────────────────────────────────────────────────────────────────────
// Aplica las migraciones de ./drizzle a la base de DATABASE_URL.
// Usa la misma config que el app (SSL + prepare:false para Supabase pooler).
//   Ejecutar:  npx tsx scripts/migrar.ts
// ─────────────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL en el .env");
  process.exit(1);
}

const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

try {
  console.log("Conectando y aplicando migraciones…");
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle" });

  // Confirmar qué tablas wa_* quedaron creadas.
  const tablas = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'wa_%'
    ORDER BY table_name
  `;
  console.log("✅ Migración aplicada. Tablas del bot:");
  for (const t of tablas) console.log("   •", t.table_name);
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
