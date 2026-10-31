import "dotenv/config";
import http from "node:http";
import type { ProcessRole } from "./app";
import { PRODUCT_NAME } from "./platform/brand";
import { productionConfigWarnings, productionSecretProblems } from "./platform/config/requiredSecrets";
import { getDb, startLocalDb } from "./platform/db/client";
import { withSafetyNet } from "./platform/net/http";
import type { Loop } from "./platform/net/scheduler";
import { drainTasks, pendingTaskCount } from "./platform/net/shutdown";
import { alertChannelsWarning, configuredAlertChannels } from "./platform/observability/alerts";
import { log } from "./platform/observability/log";
import { startMetricsReport } from "./platform/observability/metrics";
import { captureError, initSentry, isSentryConfigured } from "./platform/observability/sentry";
import { startQueueMonitor, startQueueWorker, type QueueWorker } from "./platform/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Arranque del proceso (node:http, sin framework). Siempre sobre Postgres: con
// DATABASE_URL, la base configurada; sin ella (desarrollo, E2E), un Postgres en el mismo
// proceso (PGlite) con las migraciones reales. En producción DATABASE_URL es obligatoria.
//
// Qué sirve cada ruta vive en ./app.ts; acá solo se arma el proceso: Sentry, base,
// servidor HTTP, loops de fondo según el rol y apagado ordenado.
// ─────────────────────────────────────────────────────────────────────────────

initSentry(); // antes de aceptar tráfico: registra los handlers globales de error.

// ── Fail-closed de secretos en producción ──
// Antes de cargar la app (que importa los módulos de sesión y de cifrado): sin
// PANEL_SESSION_SECRET o TOKENS_ENCRYPTION_KEY (o con un placeholder de .env.example, o
// un secreto corto/adivinable) el proceso no atiende ni un request, y el mensaje lista
// TODO lo que falla de una vez. Ver src/platform/config/requiredSecrets.ts.
const secretProblems = productionSecretProblems();
if (secretProblems.length > 0) {
  console.error(`❌ Faltan secretos obligatorios en producción (o no sirven):\n${secretProblems.map((p) => `   • ${p}`).join("\n")}`);
  process.exit(1);
}
for (const warning of productionConfigWarnings()) console.warn(`⚠️  ${warning}`);

// La app y los handlers de la cola se cargan recién ahora (import dinámico): así el
// chequeo de arriba corre antes que cualquier módulo que lea los secretos al importarse
// (src/jobs.ts trae los módulos del dominio, y con ellos la sesión).
const { createAppHandler, createWorkerHandler } = await import("./app");
const { createJobGate, registerJobHandlers, startModuleSchedulers } = await import("./jobs");
const { createPlans } = await import("./plans");

const PORT = Number(process.env.PORT ?? 3000);

// ── Rol del proceso (`ROLE`) ──
// "all" (default): un solo proceso con HTTP + workers + schedulers. "web": solo HTTP,
// sin trabajo de fondo. "worker": trabajo de fondo + un HTTP mínimo que solo sirve
// /health. Con varias réplicas worker, los schedulers se coordinan por lease de
// liderazgo (src/platform/net/leaderLease.ts) y las colas por su claim atómico.
function parseRole(raw: string | undefined): ProcessRole {
  const v = (raw ?? "").trim();
  if (v === "web" || v === "worker" || v === "all") return v;
  if (v) console.warn(`[server] ROLE="${v}" no es válido (web | worker | all): uso "all".`);
  return "all";
}
const ROLE = parseRole(process.env.ROLE);
const SERVES_WEB = ROLE !== "worker";
const RUNS_BACKGROUND = ROLE !== "web";

if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ DATABASE_URL es obligatoria en producción (sin ella no hay dónde guardar nada).");
    process.exit(1);
  }
  await startLocalDb();
  const where = process.env.PGLITE_DIR ? ` en ${process.env.PGLITE_DIR}` : ", en memoria: no persiste";
  console.warn(`[db] sin DATABASE_URL: Postgres local en el proceso (PGlite)${where}.`);
}

// Pool único del proceso, compartido por el HTTP y el trabajo de fondo.
const db = getDb();
// Planes del proceso (módulos, cupos, topes del agente, pausa): una sola instancia para el
// router, el pipeline de WhatsApp y la cola.
const plans = createPlans(db);

function reportHttpError(e: unknown): void {
  console.error("[server] error no manejado en un request:", e);
  captureError(e, { route: "http" });
}

const handler = SERVES_WEB ? createAppHandler({ db, role: ROLE, plans }) : createWorkerHandler({ db, role: ROLE });
const server = http.createServer(withSafetyNet(handler, reportHttpError));

server.on("error", (e) => {
  console.error(`[server] no se pudo escuchar en el puerto ${PORT}:`, e);
  process.exit(1);
});

// Loops de fondo (schedulers) y worker de la cola de este proceso, para frenarlos al apagar.
const loops: Loop[] = [];
let queueWorker: QueueWorker | null = null;

server.listen(PORT, () => {
  const storage = process.env.DATABASE_URL ? "PostgreSQL" : "PostgreSQL local (PGlite)";
  console.log(`${PRODUCT_NAME} escuchando en http://localhost:${PORT}  ·  Rol: ${ROLE}  ·  Base: ${storage}`);
  if (!SERVES_WEB) console.log("Rol worker: sin landing/panel/API en este proceso (solo /health).");
  console.log(`Sentry: ${isSentryConfigured() ? "activo ✅" : "no configurado (opcional, falta SENTRY_DSN)"}`);
  console.log(`Alertas a la plataforma: ${configuredAlertChannels().join(" + ")}`);
  // Producción sin canal que llegue a una persona: además del aviso de arriba, un error en el log estructurado.
  if (alertChannelsWarning()) log.error("platform_alerts_unconfigured", { channels: configuredAlertChannels() });

  // Trabajo de fondo: con `ROLE=web` este proceso no lo arranca (lo atiende la réplica
  // worker, o este mismo proceso con `ROLE=all`). El worker de la cola corre los handlers
  // que registren los módulos (src/platform/queue); sin ninguno registrado no reclama nada.
  if (RUNS_BACKGROUND) {
    loops.push(startMetricsReport(db));
    registerJobHandlers({ plans });
    // Un negocio pausado (cobro manual) no procesa trabajo nuevo: la cola lo posterga (salvo
    // completar lo que ya entró por WhatsApp, sin responder).
    queueWorker = startQueueWorker({ db, canRunJob: createJobGate(db, plans) });
    loops.push(startQueueMonitor(db)); // alertas `queue_backlog` / `queue_stuck` (src/platform/queue/monitor.ts)
    loops.push(...startModuleSchedulers(db, plans));
  }
});

// ── Apagado ordenado (deploy con `pm2 reload`, o SIGTERM del sistema) ──
// Deja de aceptar conexiones y de reclamar trabajo, espera las tareas en curso (con tope)
// y sale. PM2 tiene kill_timeout de 30 s (ecosystem.config.cjs). Ver
// src/platform/net/shutdown.ts.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);
let exiting = false;
async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  console.log(`[server] ${signal}: apagado ordenado (${pendingTaskCount()} tarea(s) en curso, espera máx ${SHUTDOWN_GRACE_MS} ms)…`);
  for (const loop of loops) loop.stop();
  // La cola deja de reclamar ya; sus jobs en curso los espera drainTasks (trackTask).
  void queueWorker?.stop();
  server.close();
  server.closeIdleConnections?.();
  const finished = await drainTasks(SHUTDOWN_GRACE_MS);
  if (!finished) console.warn("[server] quedaron tareas sin terminar: el reaper las retoma al volver.");
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
