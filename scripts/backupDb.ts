import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import path from "node:path";
import { isDumpComplete, selectBackupsToPrune } from "../src/platform/db/backups";
import { captureError, flushSentry, initSentry } from "../src/platform/observability/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Backup diario de la base. Supabase Free NO incluye backups automáticos (eso es de Pro
// en adelante), así que lo armamos nosotros: corre `pg_dump` vía cron en el servidor y
// guarda un .sql.gz por día en ./backups (fuera de git — tiene datos reales de clientes).
// Requiere `pg_dump` en el PATH (paquete `postgresql-client` del sistema, no npm).
//
// Usa BACKUP_DATABASE_URL: la conexión DIRECTA de Supabase (puerto 5432), NO el pooler de
// transacciones (6543) — pg_dump necesita estado de sesión que el pooler en modo
// transacción no garantiza. Sin esa variable cae a DATABASE_URL_MIGRATIONS/DATABASE_URL
// con un aviso (puede fallar si es el pooler).
//
// Garantías:
//   • Se escribe a un `.partial` y solo se renombra a `.sql.gz` si `pg_dump` salió con
//     código 0 Y el volcado trae la marca de cierre. Un dump a medias se borra.
//   • La poda corre SOLO si el backup de hoy salió bien, y siempre conserva los
//     BACKUP_MIN_KEEP más recientes (default 3) aunque sean viejos.
//   • Si falla, reporta a Sentry (si hay SENTRY_DSN) y sale con código 1.
//   • Copia fuera del servidor: si hay BACKUP_COPY_COMMAND, se ejecuta tras un backup
//     bueno con `{file}` reemplazado por la ruta del .sql.gz (ej. `rclone copy {file}
//     remoto:backups`, o un `gpg` + subida). Si falla, también alerta. Sin copia externa,
//     un servidor perdido = base y backups perdidos.
//
//   Ejecutar a mano:  npx tsx scripts/backupDb.ts
//   Cron (diario):    0 3 * * * cd ~/app && /usr/bin/node --import tsx scripts/backupDb.ts >> backups/backup.log 2>&1
// ─────────────────────────────────────────────────────────────────────────────

initSentry();

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
const MIN_KEEP = Number(process.env.BACKUP_MIN_KEEP ?? 3);
const COPY_COMMAND = process.env.BACKUP_COPY_COMMAND?.trim();
const FOLDER = path.resolve("backups");

async function fail(message: string, e?: unknown): Promise<never> {
  console.error(`❌ ${message}`, e instanceof Error ? e.message : (e ?? ""));
  captureError(e instanceof Error ? e : new Error(message), { script: "backupDb", message });
  await flushSentry();
  process.exit(1);
}

const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL;
if (!url) await fail("Falta BACKUP_DATABASE_URL (o DATABASE_URL) en el .env");
if (!process.env.BACKUP_DATABASE_URL) {
  console.warn(
    "⚠️  No hay BACKUP_DATABASE_URL: usando DATABASE_URL. Si es el pooler de Supabase (puerto 6543), " +
      "pg_dump puede fallar — configurá BACKUP_DATABASE_URL con la conexión DIRECTA (puerto 5432).",
  );
}

if (!existsSync(FOLDER)) mkdirSync(FOLDER, { recursive: true });

const date = new Date().toISOString().slice(0, 10);
const destination = path.join(FOLDER, `db_${date}.sql.gz`);
const partial = `${destination}.partial`;

console.log(`Volcando la base a ${destination}…`);

try {
  const pgDump = spawn("pg_dump", [url!, "--no-owner", "--no-privileges"]);
  const gzip = createGzip();
  const file = createWriteStream(partial);

  pgDump.stderr.on("data", (d) => process.stderr.write(d));

  // Cola del volcado SIN comprimir, para verificar la marca de cierre de pg_dump.
  let tail = "";
  pgDump.stdout.on("data", (d: Buffer) => {
    tail = (tail + d.toString("utf8")).slice(-512);
  });

  const exitCode = new Promise<number>((resolve, reject) => {
    pgDump.on("error", reject); // p. ej. ENOENT si falta instalar postgresql-client
    pgDump.on("exit", (c) => resolve(c ?? 1));
  });
  const written = new Promise<void>((resolve, reject) => {
    file.on("close", resolve);
    file.on("error", reject);
  });

  pgDump.stdout.pipe(gzip).pipe(file);

  const [code] = await Promise.all([exitCode, written]);
  if (code !== 0) throw new Error(`pg_dump terminó con código ${code}`);
  if (!isDumpComplete(tail)) throw new Error("el volcado no trae la marca de cierre de pg_dump (incompleto)");

  renameSync(partial, destination);
  console.log(`✅ Backup completado (${(statSync(destination).size / 1024).toFixed(0)} KB).`);
} catch (e) {
  try {
    if (existsSync(partial)) unlinkSync(partial);
  } catch {
    // no se pudo borrar el parcial: no tapa el error real
  }
  await fail("Backup falló (no se poda nada):", e);
}

// Copia fuera del servidor (opcional pero recomendado).
if (COPY_COMMAND) {
  const command = COPY_COMMAND.replaceAll("{file}", JSON.stringify(destination));
  const code = await new Promise<number>((resolve) => {
    const p = spawn(command, { shell: true, stdio: "inherit" });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) await fail(`La copia externa falló (código ${code}); el backup local SÍ quedó.`);
  console.log("☁️  Copia externa completada.");
} else {
  console.warn("⚠️  Sin BACKUP_COPY_COMMAND: el backup solo vive en este servidor.");
}

// Poda: SOLO tras un backup bueno, y conservando siempre los más recientes.
const files = readdirSync(FOLDER)
  .filter((n) => n.endsWith(".sql.gz"))
  .map((name) => ({ name, mtimeMs: statSync(path.join(FOLDER, name)).mtimeMs }));
for (const name of selectBackupsToPrune(files, Date.now(), RETENTION_DAYS, MIN_KEEP)) {
  unlinkSync(path.join(FOLDER, name));
  console.log(`🗑️  Borrado backup viejo: ${name}`);
}
