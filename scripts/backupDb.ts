import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Backup diario de la base (ROADMAP B5). Supabase Free NO incluye backups
// automáticos (eso es de Pro en adelante), así que lo armamos nosotros: corre
// `pg_dump` vía cron en el droplet y guarda un .sql.gz por día en ./backups
// (fuera de git — tiene datos reales de clientes). Requiere `pg_dump` en el
// PATH (paquete `postgresql-client` del sistema, no es una dependencia npm).
//
// Usa BACKUP_DATABASE_URL: la conexión DIRECTA de Supabase (puerto 5432), NO
// el pooler de transacciones (6543) que usa la app en producción — pg_dump
// necesita estado de sesión que el pooler en modo transacción no garantiza.
// Sin esa variable, cae a DATABASE_URL con un aviso (puede fallar si es el pooler).
//
//   Ejecutar a mano:  npx tsx scripts/backupDb.ts
//   Cron (diario):    0 3 * * * cd ~/lavacar-whatsapp-bot && npx tsx scripts/backupDb.ts >> backups/backup.log 2>&1
// ─────────────────────────────────────────────────────────────────────────────

const RETENCION_DIAS = Number(process.env.BACKUP_RETENCION_DIAS ?? 14);
const CARPETA = path.resolve("backups");

const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta BACKUP_DATABASE_URL (o DATABASE_URL) en el .env");
  process.exit(1);
}
if (!process.env.BACKUP_DATABASE_URL) {
  console.warn(
    "⚠️  No hay BACKUP_DATABASE_URL: usando DATABASE_URL. Si es el pooler de Supabase (puerto 6543), " +
      "pg_dump puede fallar — configurá BACKUP_DATABASE_URL con la conexión DIRECTA (puerto 5432).",
  );
}

if (!existsSync(CARPETA)) mkdirSync(CARPETA, { recursive: true });

const fecha = new Date().toISOString().slice(0, 10);
const destino = path.join(CARPETA, `wa_bot_${fecha}.sql.gz`);

console.log(`Volcando la base a ${destino}…`);

try {
  const pgDump = spawn("pg_dump", [url, "--no-owner", "--no-privileges"]);
  const gzip = createGzip();
  const archivo = createWriteStream(destino);

  pgDump.stderr.on("data", (d) => process.stderr.write(d));

  const codigoProm = new Promise<number>((resolve, reject) => {
    pgDump.on("error", reject); // p.ej. ENOENT si falta instalar postgresql-client
    pgDump.on("exit", (c) => resolve(c ?? 1));
  });
  const escritoProm = new Promise<void>((resolve, reject) => {
    archivo.on("close", resolve);
    archivo.on("error", reject);
  });

  pgDump.stdout.pipe(gzip).pipe(archivo);

  const [codigo] = await Promise.all([codigoProm, escritoProm]);
  if (codigo !== 0) throw new Error(`pg_dump terminó con código ${codigo}`);

  console.log("✅ Backup completado.");
} catch (e) {
  console.error("❌ Backup falló:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}

// Poda: borra backups más viejos que RETENCION_DIAS. Corre siempre (incluso si el
// backup de hoy falló) para no acumular basura vieja indefinidamente.
const ahora = Date.now();
for (const nombre of readdirSync(CARPETA)) {
  if (!nombre.endsWith(".sql.gz")) continue;
  const ruta = path.join(CARPETA, nombre);
  const edadDias = (ahora - statSync(ruta).mtimeMs) / (1000 * 60 * 60 * 24);
  if (edadDias > RETENCION_DIAS) {
    unlinkSync(ruta);
    console.log(`🗑️  Borrado backup viejo: ${nombre}`);
  }
}
