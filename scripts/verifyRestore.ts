import "dotenv/config";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

// ─────────────────────────────────────────────────────────────────────────────
// Verificación de backups: RESTAURA un volcado en una base vacía y separada y compara
// conteos contra la base de origen. Un backup que nunca se restauró no es un backup.
//
//   npx tsx scripts/verifyRestore.ts [backups/db_AAAA-MM-DD.sql.gz]
//
// Sin argumento usa el volcado más nuevo de ./backups. Necesita `psql` (postgresql-client).
//
//   RESTORE_DATABASE_URL  → base DESTINO, vacía y separada (p. ej. un proyecto Supabase
//                           aparte o un Postgres local). Se le escribe encima.
//   BACKUP_DATABASE_URL   → base de ORIGEN para comparar (o DATABASE_URL_MIGRATIONS /
//                           DATABASE_URL). Solo se lee.
//
// Salvaguardas: se niega a correr si el destino coincide con el origen o con las URLs de
// la app, o si el destino ya tiene tablas en `public`. Sale con código ≠ 0 si algo no
// cierra, así se puede programar (cron mensual) y alertar.
// ─────────────────────────────────────────────────────────────────────────────

const target = process.env.RESTORE_DATABASE_URL;
const source = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL;

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

if (!target) fail("Falta RESTORE_DATABASE_URL (la base vacía donde se restaura el volcado).");
if (!source) fail("Falta BACKUP_DATABASE_URL (o DATABASE_URL) para comparar contra el origen.");

/** host:puerto/base de una URL de Postgres, para comparar sin credenciales. */
function identity(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}
const protectedDbs = [source, process.env.DATABASE_URL, process.env.DATABASE_URL_MIGRATIONS]
  .filter((u): u is string => !!u)
  .map(identity);
if (protectedDbs.includes(identity(target))) {
  fail("RESTORE_DATABASE_URL apunta a la misma base que el origen o la app. Usá una base separada.");
}

function pickDump(): string {
  const arg = process.argv[2];
  if (arg) {
    if (!existsSync(arg)) fail(`No existe el volcado ${arg}`);
    return arg;
  }
  const folder = path.resolve("backups");
  if (!existsSync(folder)) fail("No hay carpeta ./backups (corré scripts/backupDb.ts primero).");
  const candidates = readdirSync(folder)
    .filter((n) => n.endsWith(".sql.gz"))
    .map((n) => path.join(folder, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates.length) fail("No hay volcados .sql.gz en ./backups.");
  return candidates[0];
}

const connect = (url: string) =>
  /supabase\.(co|com)/.test(url) ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

async function publicTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ t: string }[]>`
    SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`;
  return rows.map((r) => r.t);
}

async function countRows(sql: postgres.Sql, tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of tables) {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)}`;
    out.set(t, r.n);
  }
  return out;
}

const dump = pickDump();
console.log(`Volcado: ${dump} (${(statSync(dump).size / 1024).toFixed(0)} KB)`);

const targetSql = connect(target);
const existing = await publicTables(targetSql);
if (existing.length) {
  await targetSql.end();
  fail(`La base destino ya tiene ${existing.length} tabla(s) en public. Tiene que estar vacía.`);
}

console.log("Restaurando con psql (ON_ERROR_STOP)…");
const code = await new Promise<number>((resolve) => {
  const psql = spawn("psql", [target, "-v", "ON_ERROR_STOP=1", "-q"], { stdio: ["pipe", "inherit", "inherit"] });
  psql.on("error", (e) => {
    console.error("No se pudo ejecutar psql (¿falta postgresql-client?):", e.message);
    resolve(1);
  });
  psql.on("exit", (c) => resolve(c ?? 1));
  createReadStream(dump).pipe(createGunzip()).pipe(psql.stdin);
});
if (code !== 0) {
  await targetSql.end();
  fail(`psql terminó con código ${code}: el volcado NO se pudo restaurar.`);
}

const sourceSql = connect(source);
const sourceTables = await publicTables(sourceSql);
const restoredTables = await publicTables(targetSql);
const [sourceCounts, targetCounts] = await Promise.all([countRows(sourceSql, sourceTables), countRows(targetSql, restoredTables)]);
const [{ n: sourceMigrations }] = await sourceSql<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
const [{ n: targetMigrations }] = await targetSql<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
await Promise.all([sourceSql.end(), targetSql.end()]);

const problems: string[] = [];
console.log("\nTabla                          origen    restaurado");
for (const t of sourceTables) {
  const o = sourceCounts.get(t) ?? 0;
  const d = targetCounts.get(t);
  console.log(`${t.padEnd(30)} ${String(o).padStart(7)}  ${d === undefined ? "  FALTA" : String(d).padStart(10)}`);
  if (d === undefined) problems.push(`falta la tabla ${t}`);
  // El origen sigue recibiendo datos después del volcado: el restaurado puede tener MENOS
  // filas, nunca más; y una tabla con datos en el origen no puede volver vacía.
  else if (d > o) problems.push(`${t}: el restaurado tiene más filas que el origen (${d} > ${o})`);
  else if (o > 0 && d === 0) problems.push(`${t}: vacía en el restaurado (origen: ${o})`);
}
console.log(`\nMigraciones aplicadas: origen ${sourceMigrations}, restaurado ${targetMigrations}`);
if (targetMigrations !== sourceMigrations) problems.push(`migraciones distintas (origen ${sourceMigrations}, restaurado ${targetMigrations})`);

if (problems.length) {
  console.error("\n❌ El restore NO cierra:");
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}
console.log("\n✅ Restore verificado: el volcado se restaura completo y los conteos cierran.");
