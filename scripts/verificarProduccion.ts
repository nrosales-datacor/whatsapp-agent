import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// E14 (ROADMAP Carril E): "backups + Sentry + uptime verificados en producción"
// no es código — es la checklist de DEPLOY.md §16-19, y nada del repo la
// corría de punta a punta. "Perdimos tus conversaciones y tus citas" es
// terminal para un cliente que paga.
//
// Este script NO reemplaza la verificación real: el restore lo prueba
// `scripts/verificarRestore.ts` (H6, DEPLOY.md §19.2) y las alertas de
// UptimeRobot/Sentry solo se confirman en sus dashboards. Lo que sí hace es
// convertir en un comando de 10 s las partes que se pueden leer DESDE el
// propio droplet, para no depender de la memoria de nadie ("¿el cron seguía
// corriendo?", "¿la copia externa quedó configurada?").
//
// Correr EN EL DROPLET (no en local: mira crontab y ./backups del proceso
// real), parado en la carpeta del proyecto:
//   node --import tsx scripts/verificarProduccion.ts   (o npm run verificar:produccion)
// Sale con código 1 si algún chequeo falla.
// ─────────────────────────────────────────────────────────────────────────────

let huboProblemas = false;
const ok = (msg: string) => console.log(`✅ ${msg}`);
const mal = (msg: string) => {
  console.error(`❌ ${msg}`);
  huboProblemas = true;
};
const advertencia = (msg: string) => console.warn(`⚠️  ${msg}`);

// El backup avisa sus fallos por Sentry (backupDb.ts → capturarError), así que
// sin SENTRY_DSN un backup roto pasa en silencio.
console.log("── Sentry (DEPLOY.md §16) ──────────────────────────────────────");
if (process.env.SENTRY_DSN) {
  ok(
    'SENTRY_DSN configurado. Esto NO confirma que las alertas lleguen: revisá a mano ' +
      '`pm2 logs whatsapp-bot` (debe decir "Sentry: activo ✅" al arrancar) y que el ' +
      "dashboard de Sentry tenga alertas por email/Slack para issues nuevos (§16, paso 4).",
  );
} else {
  mal(
    "SENTRY_DSN no está configurado — un error en el server, el worker o el backup diario " +
      "se pierde en los logs sin avisar a nadie.",
  );
}

console.log("\n── Cron de backups (DEPLOY.md §19.1) ───────────────────────────");
let crontab = "";
try {
  crontab = execSync("crontab -l", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {
  advertencia("No se pudo leer crontab del usuario actual (¿corriste esto en el droplet, con el usuario que instaló el cron?).");
}
if (/backupDb\.ts/.test(crontab)) {
  ok("Hay una línea de crontab que corre backupDb.ts.");
} else {
  mal("No hay ninguna línea de crontab que llame a backupDb.ts — sin eso no hay backups automáticos.");
}

console.log("\n── Backup reciente (DEPLOY.md §19.1) ───────────────────────────");
const CARPETA_BACKUPS = path.resolve("backups");
if (!existsSync(CARPETA_BACKUPS)) {
  mal(`No existe la carpeta ${CARPETA_BACKUPS} — nunca corrió un backup en este droplet.`);
} else {
  const archivos = readdirSync(CARPETA_BACKUPS);
  const dumps = archivos.filter((f) => f.endsWith(".sql.gz"));
  if (dumps.length === 0) {
    mal(`La carpeta ${CARPETA_BACKUPS} existe pero no tiene ningún .sql.gz.`);
  } else {
    const [masReciente] = dumps
      .map((f) => ({ f, mtimeMs: statSync(path.join(CARPETA_BACKUPS, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const horas = (Date.now() - masReciente.mtimeMs) / (1000 * 60 * 60);
    if (horas > 48) {
      mal(`El backup más reciente (${masReciente.f}) tiene ${Math.round(horas)} h — el cron debería correr a diario. Revisá backups/backup.log.`);
    } else {
      ok(`Backup más reciente: ${masReciente.f} (hace ${Math.round(horas)} h, ${dumps.length} en total).`);
    }
  }
  // backupDb.ts borra el `.parcial` cuando pg_dump falla; si queda uno, el proceso
  // murió a mitad del volcado (OOM, reinicio del droplet) sin llegar a avisar.
  const parciales = archivos.filter((f) => f.endsWith(".parcial"));
  if (parciales.length > 0) {
    advertencia(`Hay ${parciales.length} volcado(s) a medias (${parciales.join(", ")}): un backup murió sin terminar. Revisá backups/backup.log y borralos.`);
  }
}

console.log("\n── Conexión y copia externa (DEPLOY.md §19.1) ──────────────────");
if (process.env.BACKUP_DATABASE_URL) {
  ok("BACKUP_DATABASE_URL configurada (debe ser la conexión DIRECTA, puerto 5432 — no el pooler).");
} else if (process.env.DATABASE_URL_MIGRACIONES || process.env.DATABASE_URL) {
  advertencia(
    "No hay BACKUP_DATABASE_URL: backupDb.ts cae a DATABASE_URL_MIGRACIONES/DATABASE_URL, que en " +
      "producción puede ser el pooler (6543) y hacer fallar pg_dump.",
  );
} else {
  mal("Ni BACKUP_DATABASE_URL ni DATABASE_URL están configuradas.");
}
if (process.env.BACKUP_COMANDO_COPIA?.trim()) {
  ok("BACKUP_COMANDO_COPIA configurado: cada backup bueno se copia fuera del droplet.");
} else {
  advertencia("Sin BACKUP_COMANDO_COPIA: los backups solo viven en este droplet — si se pierde el droplet, se pierden con él (§19.1, paso 6).");
}

console.log(
  "\nEsto NO se puede chequear desde un script — hacelo a mano:\n" +
    "  · Restore de verdad con scripts/verificarRestore.ts contra una base aparte (DEPLOY.md §19.2;\n" +
    "    cierra H6/E14). Repetirlo cada 2-3 meses.\n" +
    "  · Uptime monitor (UptimeRobot) creado y con alertas activas (DEPLOY.md §17).\n" +
    "  · Alertas de Sentry por email/Slack activadas en su dashboard (DEPLOY.md §16, paso 4).",
);

if (huboProblemas) {
  console.error("\n❌ Hay al menos un punto sin resolver — ver arriba.");
  process.exit(1);
}
console.log("\n✅ Los chequeos automatizables pasaron. Todavía falta confirmar a mano lo de la lista de arriba.");
