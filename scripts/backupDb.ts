import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import path from "node:path";
import { dumpCompleto, elegirBackupsAPodar } from "../src/db/backups";
import { capturarError, iniciarSentry, vaciarSentry } from "../src/observabilidad/sentry";

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
// Garantías (revisión pre-venta 2026-10, Carril G — G8):
//   • Se escribe a un `.parcial` y solo se renombra a `.sql.gz` si `pg_dump` salió
//     con código 0 Y el volcado trae la marca de cierre. Un dump a medias se borra.
//   • La poda corre SOLO si el backup de hoy salió bien, y siempre conserva los
//     BACKUP_MINIMO más recientes (default 3) aunque sean viejos.
//   • Si falla, reporta a Sentry (si hay SENTRY_DSN) y sale con código 1.
//   • Copia fuera del droplet: si hay BACKUP_COMANDO_COPIA, se ejecuta tras un
//     backup bueno con `{archivo}` reemplazado por la ruta del .sql.gz (ej.
//     `rclone copy {archivo} remoto:backups-wa`, o un `gpg` + subida). Si falla,
//     también alerta. Sin copia externa, un droplet perdido = base y backups perdidos.
//
//   Ejecutar a mano:  npx tsx scripts/backupDb.ts
//   Cron (diario):    0 3 * * * cd ~/lavacar-whatsapp-bot && npx tsx scripts/backupDb.ts >> backups/backup.log 2>&1
// ─────────────────────────────────────────────────────────────────────────────

iniciarSentry();

const RETENCION_DIAS = Number(process.env.BACKUP_RETENCION_DIAS ?? 14);
const MINIMO_A_CONSERVAR = Number(process.env.BACKUP_MINIMO ?? 3);
const COMANDO_COPIA = process.env.BACKUP_COMANDO_COPIA?.trim();
const CARPETA = path.resolve("backups");

async function fallar(mensaje: string, e?: unknown): Promise<never> {
  console.error(`❌ ${mensaje}`, e instanceof Error ? e.message : (e ?? ""));
  capturarError(e instanceof Error ? e : new Error(mensaje), { script: "backupDb", mensaje });
  await vaciarSentry();
  process.exit(1);
}

const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) await fallar("Falta BACKUP_DATABASE_URL (o DATABASE_URL) en el .env");
if (!process.env.BACKUP_DATABASE_URL) {
  console.warn(
    "⚠️  No hay BACKUP_DATABASE_URL: usando DATABASE_URL. Si es el pooler de Supabase (puerto 6543), " +
      "pg_dump puede fallar — configurá BACKUP_DATABASE_URL con la conexión DIRECTA (puerto 5432).",
  );
}

if (!existsSync(CARPETA)) mkdirSync(CARPETA, { recursive: true });

const fecha = new Date().toISOString().slice(0, 10);
const destino = path.join(CARPETA, `wa_bot_${fecha}.sql.gz`);
const parcial = `${destino}.parcial`;

console.log(`Volcando la base a ${destino}…`);

try {
  const pgDump = spawn("pg_dump", [url!, "--no-owner", "--no-privileges"]);
  const gzip = createGzip();
  const archivo = createWriteStream(parcial);

  pgDump.stderr.on("data", (d) => process.stderr.write(d));

  // Cola del volcado SIN comprimir, para verificar la marca de cierre de pg_dump.
  let cola = "";
  pgDump.stdout.on("data", (d: Buffer) => {
    cola = (cola + d.toString("utf8")).slice(-512);
  });

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
  if (!dumpCompleto(cola)) throw new Error("el volcado no trae la marca de cierre de pg_dump (incompleto)");

  renameSync(parcial, destino);
  console.log(`✅ Backup completado (${(statSync(destino).size / 1024).toFixed(0)} KB).`);
} catch (e) {
  try {
    if (existsSync(parcial)) unlinkSync(parcial);
  } catch {
    // no se pudo borrar el parcial: no tapa el error real
  }
  await fallar("Backup falló (no se poda nada):", e);
}

// Copia fuera del droplet (opcional pero recomendado).
if (COMANDO_COPIA) {
  const comando = COMANDO_COPIA.replaceAll("{archivo}", JSON.stringify(destino));
  const codigo = await new Promise<number>((resolve) => {
    const p = spawn(comando, { shell: true, stdio: "inherit" });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
  if (codigo !== 0) await fallar(`La copia externa falló (código ${codigo}); el backup local SÍ quedó.`);
  console.log("☁️  Copia externa completada.");
} else {
  console.warn("⚠️  Sin BACKUP_COMANDO_COPIA: el backup solo vive en este servidor.");
}

// Poda: SOLO tras un backup bueno, y conservando siempre los más recientes.
const archivos = readdirSync(CARPETA)
  .filter((n) => n.endsWith(".sql.gz"))
  .map((nombre) => ({ nombre, mtimeMs: statSync(path.join(CARPETA, nombre)).mtimeMs }));
for (const nombre of elegirBackupsAPodar(archivos, Date.now(), RETENCION_DIAS, MINIMO_A_CONSERVAR)) {
  unlinkSync(path.join(CARPETA, nombre));
  console.log(`🗑️  Borrado backup viejo: ${nombre}`);
}
