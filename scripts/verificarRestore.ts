import "dotenv/config";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

// ─────────────────────────────────────────────────────────────────────────────
// Verificación de backups: RESTAURA un volcado en una base vacía y separada y compara
// conteos contra la base de origen. Es la parte que cierra B5/E14 del ROADMAP: un backup
// que nunca se restauró no es un backup.
//
//   npx tsx scripts/verificarRestore.ts [backups/wa_bot_AAAA-MM-DD.sql.gz]
//
// Sin argumento usa el volcado más nuevo de ./backups. Necesita `psql` (postgresql-client).
//
//   RESTORE_DATABASE_URL  → base DESTINO, vacía y separada (p. ej. un proyecto Supabase
//                           aparte o un Postgres local). Se le escribe encima.
//   BACKUP_DATABASE_URL   → base de ORIGEN para comparar (o DATABASE_URL_MIGRACIONES /
//                           DATABASE_URL). Solo se lee.
//
// Salvaguardas: se niega a correr si el destino coincide con el origen o con las URLs de la
// app, o si el destino ya tiene tablas wa_*. Sale con código ≠ 0 si algo no cierra, así se
// puede programar (cron mensual) y alertar.
// ─────────────────────────────────────────────────────────────────────────────

const destino = process.env.RESTORE_DATABASE_URL;
const origen = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL_MIGRACIONES ?? process.env.DATABASE_URL;

function fallar(mensaje: string): never {
  console.error(`❌ ${mensaje}`);
  process.exit(1);
}

if (!destino) fallar("Falta RESTORE_DATABASE_URL (la base vacía donde se restaura el volcado).");
if (!origen) fallar("Falta BACKUP_DATABASE_URL (o DATABASE_URL) para comparar contra el origen.");

/** host:puerto/base de una URL de Postgres, para comparar sin credenciales. */
function identidad(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}
const protegidas = [origen, process.env.DATABASE_URL, process.env.DATABASE_URL_MIGRACIONES]
  .filter((u): u is string => !!u)
  .map(identidad);
if (protegidas.includes(identidad(destino))) {
  fallar("RESTORE_DATABASE_URL apunta a la misma base que el origen o la app. Usá una base separada.");
}

function elegirVolcado(): string {
  const arg = process.argv[2];
  if (arg) {
    if (!existsSync(arg)) fallar(`No existe el volcado ${arg}`);
    return arg;
  }
  const carpeta = path.resolve("backups");
  if (!existsSync(carpeta)) fallar("No hay carpeta ./backups (corré scripts/backupDb.ts primero).");
  const candidatos = readdirSync(carpeta)
    .filter((n) => n.endsWith(".sql.gz"))
    .map((n) => path.join(carpeta, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidatos.length) fallar("No hay volcados .sql.gz en ./backups.");
  return candidatos[0];
}

const conexion = (url: string) =>
  /supabase\.(co|com)/.test(url) ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

async function tablasWa(sql: postgres.Sql): Promise<string[]> {
  const filas = await sql<{ t: string }[]>`
    SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'wa\\_%' ORDER BY 1`;
  return filas.map((f) => f.t);
}

async function contar(sql: postgres.Sql, tablas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of tablas) {
    const [f] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)}`;
    out.set(t, f.n);
  }
  return out;
}

const volcado = elegirVolcado();
console.log(`Volcado: ${volcado} (${(statSync(volcado).size / 1024).toFixed(0)} KB)`);

const sqlDestino = conexion(destino);
const yaTiene = await tablasWa(sqlDestino);
if (yaTiene.length) {
  await sqlDestino.end();
  fallar(`La base destino ya tiene ${yaTiene.length} tabla(s) wa_*. Tiene que estar vacía.`);
}

console.log("Restaurando con psql (ON_ERROR_STOP)…");
const codigo = await new Promise<number>((resolve) => {
  const psql = spawn("psql", [destino, "-v", "ON_ERROR_STOP=1", "-q"], { stdio: ["pipe", "inherit", "inherit"] });
  psql.on("error", (e) => {
    console.error("No se pudo ejecutar psql (¿falta postgresql-client?):", e.message);
    resolve(1);
  });
  psql.on("exit", (c) => resolve(c ?? 1));
  createReadStream(volcado).pipe(createGunzip()).pipe(psql.stdin);
});
if (codigo !== 0) {
  await sqlDestino.end();
  fallar(`psql terminó con código ${codigo}: el volcado NO se pudo restaurar.`);
}

const sqlOrigen = conexion(origen);
const tablasOrigen = await tablasWa(sqlOrigen);
const tablasRestauradas = await tablasWa(sqlDestino);
const [conteosOrigen, conteosDestino] = await Promise.all([contar(sqlOrigen, tablasOrigen), contar(sqlDestino, tablasRestauradas)]);
const [{ n: migOrigen }] = await sqlOrigen<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
const [{ n: migDestino }] = await sqlDestino<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
await Promise.all([sqlOrigen.end(), sqlDestino.end()]);

const problemas: string[] = [];
console.log("\nTabla                          origen    restaurado");
for (const t of tablasOrigen) {
  const o = conteosOrigen.get(t) ?? 0;
  const d = conteosDestino.get(t);
  console.log(`${t.padEnd(30)} ${String(o).padStart(7)}  ${d === undefined ? "  FALTA" : String(d).padStart(10)}`);
  if (d === undefined) problemas.push(`falta la tabla ${t}`);
  // El origen sigue recibiendo datos después del volcado: el restaurado puede tener MENOS
  // filas, nunca más; y una tabla con datos en el origen no puede volver vacía.
  else if (d > o) problemas.push(`${t}: el restaurado tiene más filas que el origen (${d} > ${o})`);
  else if (o > 0 && d === 0) problemas.push(`${t}: vacía en el restaurado (origen: ${o})`);
}
console.log(`\nMigraciones aplicadas: origen ${migOrigen}, restaurado ${migDestino}`);
if (migDestino !== migOrigen) problemas.push(`migraciones distintas (origen ${migOrigen}, restaurado ${migDestino})`);

if (problemas.length) {
  console.error("\n❌ El restore NO cierra:");
  for (const p of problemas) console.error(`   • ${p}`);
  process.exit(1);
}
console.log("\n✅ Restore verificado: el volcado se restaura completo y los conteos cierran.");
