import "dotenv/config";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { verificarWebhook, firmaValida, separarPayloadWebhook } from "./whatsapp/client";
import { ingerirEntrante } from "./handleWebhook";
import { RepositorioDrizzle } from "./booking/drizzleRepository";
import { iniciarDbLocal, obtenerDb } from "./db/client";
import { iniciarRecordatorios } from "./reminders/scheduler";
import { iniciarReputacion, placesConfigurado } from "./reputacion/places";
import { cargarTenants, alRecargar } from "./config/tenantStore";
import { reprocesarPendientes } from "./reprocesoWebhooks";
import { credencialesCalendarioConfiguradas } from "./calendar/googleCalendar";
import { manejarPanel } from "./panel/router";
import { manejarLanding } from "./landing/servirLanding";
import { pushConfigurado } from "./panel/push";
import { iniciarWorker } from "./queue/worker";
import { iniciarCampanias } from "./campaigns/worker";
import { iniciarRescate } from "./rescate/worker";
import { iniciarSentry, sentryConfigurado, capturarError } from "./observabilidad/sentry";
import { iniciarReporteMetricas } from "./observabilidad/metricas";
import { iniciarVigilancia } from "./observabilidad/vigilancia";
import { canalesDeAlertaConfigurados } from "./observabilidad/alertas";
import { chequearSalud, codigoHttpSalud } from "./salud";
import { leerCuerpoConTope, MAX_BODY_WEBHOOK, conRedDeSeguridad } from "./red/http";
import { conCabecerasSeguridad } from "./red/cabeceras";
import { esperarTareas, tareasEnCurso } from "./red/apagado";
import type { Repositorio } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Servidor del agente de WhatsApp (standalone, sin framework). Siempre sobre Postgres:
// con DATABASE_URL, la base configurada; sin ella (desarrollo, E2E), un Postgres en el
// mismo proceso (PGlite) con las migraciones reales. En producción DATABASE_URL es
// obligatoria: sin ella el proceso no arranca.
// ─────────────────────────────────────────────────────────────────────────────

iniciarSentry(); // antes de aceptar tráfico: registra los handlers globales de error (ROADMAP B5).

const PORT = Number(process.env.PORT ?? 3000);
const RUTA_WEBHOOK = "/webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Separación de procesos web/worker (ROADMAP F6). Hoy TODO corre en un único
// proceso bajo una sola instancia de PM2: sin aislamiento de fallos (un pico
// del panel degrada el webhook, comparten event loop y pool de Postgres) y un
// `pm2 restart` corta las conexiones de los 50 negocios a la vez.
//
// `ROL=todo` (default, NO rompe el piloto ni dev local si no se toca el .env)
// preserva el comportamiento de siempre: un solo proceso con servidor HTTP +
// los 3 workers de cola + los 3 schedulers. `ROL=web` sirve el webhook/panel/
// landing pero NO arranca ningún worker ni scheduler. `ROL=worker` arranca los
// workers/schedulers y sirve un HTTP mínimo (solo `/salud`, para el health
// check del propio proceso) — el webhook/panel los sirve la réplica `web`.
//
// Los 3 workers de cola (mensajes, campañas, rescate) ya son seguros ante N
// réplicas por su claim atómico (`FOR UPDATE SKIP LOCKED`, `src/queue/cola.ts`).
// Los 3 schedulers (recordatorios, reputación, reporte de métricas) no tienen
// ese claim por unidad de trabajo — usan el lease de liderazgo de
// `src/red/liderazgo.ts` para que, con N réplicas `worker`, solo UNA haga el
// trabajo real por tick.
// ─────────────────────────────────────────────────────────────────────────────
type Rol = "web" | "worker" | "todo";
const ROL: Rol = process.env.ROL === "web" || process.env.ROL === "worker" ? process.env.ROL : "todo";
const SIRVE_WEB = ROL === "web" || ROL === "todo";
const SIRVE_TRABAJO_DE_FONDO = ROL === "worker" || ROL === "todo";

if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ DATABASE_URL es obligatoria en producción (sin ella no hay dónde guardar nada).");
    process.exit(1);
  }
  await iniciarDbLocal();
  console.warn(
    `[db] sin DATABASE_URL: Postgres local en el proceso (PGlite)${process.env.PGLITE_DIR ? ` en ${process.env.PGLITE_DIR}` : ", en memoria: no persiste"}.`,
  );
}

// `db` se pasa a los workers (operan sobre las colas sin la interfaz Repositorio). Es el
// pool único del proceso (F7), compartido con el resto de los módulos.
const db = obtenerDb();
const repo: Repositorio = new RepositorioDrizzle(db);

// Reproceso de wa_webhooks_crudos (ROADMAP F3): tenantStore no puede importar
// handleWebhook (ciclo de imports — ver el comentario en reprocesoWebhooks.ts),
// así que acá, que ya conoce ambas puntas (db + repo), se conecta el callback
// genérico que expone tenantStore con el reproceso real. Se dispara después de
// CUALQUIER recarga exitosa del caché: alta de negocio (router.ts), refresco
// periódico y recarga on-demand ante un phone_number_id nuevo — son justo los
// momentos en que un mensaje que quedó "pendiente" puede volverse resoluble.
alRecargar(() => {
  reprocesarPendientes(db, repo).catch((e) => {
    console.error("[server] reprocesarPendientes falló:", e);
    capturarError(e, { modulo: "reprocesoWebhooks" });
  });
});

// Health check (antes vivía en `/`; el root ahora es la landing pública, C4.4).
// ROADMAP E10 / AUDIT.md BLOQUEANTE-11: antes esto devolvía 200 con el proceso
// vivo, sin mirar nada más. Ahora corre chequeos reales (src/salud.ts) y solo
// devuelve 200 si nada crítico falló. El contrato de texto plano en 200 se
// preserva EXACTO ("Agente de WhatsApp corriendo ✅") porque el smoke del CI
// (ci-cd.yml) hace `curl -sf` esperando un 2xx — cambiar el código rompería el
// deploy, no solo el formato.
//
// `?detalle=1` (o el content-negotiation vía Accept, evitado a propósito: un
// uptime monitor manda `Accept: */*` y terminaría recibiendo JSON igual) es el
// modo humano: JSON con cada chequeo, para debugging, nunca lo mira el monitor
// automático (que solo hace un GET plano a /salud).
//
// Factorizado en un helper (ROADMAP F6) porque ahora lo sirven DOS handlers de
// servidor distintos: el completo (`ROL=web`/`todo`) y el mínimo (`ROL=worker`,
// que no expone webhook/panel/landing — ver más abajo).
function tokenSaludValido(dado: string | null): boolean {
  const esperado = process.env.SALUD_DETALLE_TOKEN;
  if (!esperado || !dado) return false;
  const a = Buffer.from(dado);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function responderSalud(res: http.ServerResponse, url: URL): Promise<void> {
  const conDetalle = url.searchParams.get("detalle") === "1";
  // Los detectores de "bot mudo" solo corren en el modo humano (?detalle=1): el
  // GET plano del uptime monitor sigue igual de barato que antes. Como `/salud` es
  // público y la vigilancia lista ids de negocios, además exige `&token=` igual a
  // SALUD_DETALLE_TOKEN (sin esa env, la vigilancia no se expone por HTTP; las
  // alertas salen igual por el canal de alertas).
  const detalle = await chequearSalud(db, {
    incluirVigilancia: conDetalle && tokenSaludValido(url.searchParams.get("token")),
  });
  const codigo = codigoHttpSalud(detalle);
  if (conDetalle) {
    res.writeHead(codigo, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(detalle));
  } else {
    res.writeHead(codigo, { "content-type": "text/plain; charset=utf-8" });
    res.end(codigo === 200 ? "Agente de WhatsApp corriendo ✅" : "Agente de WhatsApp degradado ⚠️");
  }
}

function reportarErrorHttp(e: unknown): void {
  console.error("[server] error no manejado en un request:", e);
  capturarError(e, { ruta: "http" });
}

// Servidor HTTP completo: webhook + panel + landing + /salud. Lo usan `ROL=web`
// y `ROL=todo` (default, comportamiento idéntico al de siempre). Todas las respuestas
// salen con las cabeceras de seguridad (CSP, HSTS, nosniff…, ver src/red/cabeceras.ts).
const servidorCompleto = http.createServer(conRedDeSeguridad(conCabecerasSeguridad(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/salud") {
    await responderSalud(res, url);
    return;
  }

  // Landing pública de venta: `/`, `/privacidad`, `/terminos`, `/landing/*`, robots, favicon.
  if (manejarLanding(req, res, url.pathname)) return;

  // Panel web (bandeja humana): /panel y /api/panel/*.
  if (await manejarPanel(req, res, repo, url.pathname)) return;

  if (url.pathname !== RUTA_WEBHOOK) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // 1) Verificación del webhook (Meta hace un GET al configurarlo).
  if (req.method === "GET") {
    const r = verificarWebhook(url.searchParams);
    if (r.ok) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(r.challenge ?? "");
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
    return;
  }

  // 2) Mensajes entrantes (POST).
  if (req.method === "POST") {
    // Tope de tamaño ANTES de verificar la firma: sin él, un POST anónimo enorme
    // agota la memoria del proceso (src/red/http.ts).
    const cuerpo = await leerCuerpoConTope(req, MAX_BODY_WEBHOOK);
    if (cuerpo === null) {
      res.writeHead(413, { connection: "close" });
      res.end("Payload too large");
      return;
    }
    const raw = cuerpo.toString("utf8");

    const firma = req.headers["x-hub-signature-256"];
    if (!firmaValida(raw, typeof firma === "string" ? firma : null)) {
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    // FASE 1: persistir el entrante ANTES de responder 200. Si falla, devolvemos 500
    // y Meta reintenta — la deduplicación por waMessageId evita procesarlo dos veces.
    // Un POST puede traer VARIOS mensajes (varios entry/changes/messages): se
    // ingiere cada uno, en orden (`separarPayloadWebhook`).
    try {
      for (const parte of separarPayloadWebhook(body)) {
        await ingerirEntrante(parte, repo, db);
      }
    } catch (e) {
      console.error("[server] no se pudo persistir el mensaje entrante (Meta reintentará):", e);
      capturarError(e, { ruta: "webhook", fase: 1 });
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
      return;
    }

    // FASE 2: el job quedó encolado en la fase 1; lo consume el worker (src/queue/worker.ts).
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("EVENT_RECEIVED");
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
}), reportarErrorHttp));

// Servidor HTTP mínimo para `ROL=worker`: SOLO `/salud` (health check del
// propio proceso, para el monitor de uptime/orquestador). Sin webhook, sin
// panel, sin landing — esta réplica no acepta tráfico de negocio, solo
// consume wa_jobs y corre los schedulers (ver el `if (SIRVE_TRABAJO_DE_FONDO)`
// más abajo). Reusa `chequearSalud`/`codigoHttpSalud` (src/salud.ts) igual que
// el servidor completo: mismo criterio de "algo crítico falló → 503".
const servidorMinimo = http.createServer(conRedDeSeguridad(conCabecerasSeguridad(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/salud") {
    await responderSalud(res, url);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}), reportarErrorHttp));

const server = SIRVE_WEB ? servidorCompleto : servidorMinimo;

// Carga el registro de tenants (de la base, o fallback en memoria) ANTES de aceptar
// tráfico: ningún webhook ni login debe entrar con el caché vacío. (ROADMAP B2)
await cargarTenants();

// Datos de demo para desarrollo/diseño del panel. SOLO en la base local (PGlite): con
// DATABASE_URL (base real) se ignora para no ensuciar producción.
if (process.env.SEED_DEMO && !process.env.DATABASE_URL) {
  const { seedDemo } = await import("./panel/seedDemo");
  await seedDemo(repo).catch((e) => console.error("[seed] error:", e));
} else if (process.env.SEED_DEMO) {
  console.warn("[seed] SEED_DEMO ignorado: hay DATABASE_URL. Los datos de demo solo se cargan en la base local.");
}

server.listen(PORT, () => {
  const modo = process.env.DATABASE_URL ? "PostgreSQL" : "PostgreSQL local (PGlite)";
  console.log(`Agente escuchando en http://localhost:${PORT}  ·  Rol: ${ROL}`);
  if (SIRVE_WEB) {
    console.log(`Webhook: http://localhost:${PORT}${RUTA_WEBHOOK}  ·  Almacenamiento: ${modo}`);
  } else {
    console.log(`Rol "worker": sin webhook/panel/landing en este proceso (solo /salud) · Almacenamiento: ${modo}`);
  }
  // El calendario es POR NEGOCIO (auditoría BLOQ-05): acá solo se puede reportar si
  // están las credenciales globales de la service account. Que un tenant tenga su
  // calendario conectado se ve en su "Mi negocio", no al arrancar el proceso.
  console.log(
    `Google Calendar (credenciales): ${credencialesCalendarioConfiguradas() ? "presentes ✅ (cada negocio configura su calendario)" : "no configuradas (opcional)"}`,
  );
  console.log(`Notificaciones push: ${pushConfigurado() ? "configuradas ✅" : "no configuradas (faltan llaves VAPID)"}`);
  console.log(`Sentry: ${sentryConfigurado() ? "activo ✅" : "no configurado (opcional, falta SENTRY_DSN)"}`);
  console.log(`Alertas a la plataforma: ${canalesDeAlertaConfigurados().join(" + ")}${process.env.ALERTAS_WEBHOOK_URL ? " ✅" : " (opcional: ALERTAS_WEBHOOK_URL para Slack/Discord)"}`);
  console.log(`Reputación (Places API): ${placesConfigurado() ? "configurada ✅" : "no configurada (opcional, falta GOOGLE_PLACES_API_KEY)"}`);

  // Workers de cola + schedulers (ROADMAP F6): con `ROL=web` este proceso NO los
  // arranca — los atiende la(s) réplica(s) `worker` (o el mismo proceso si
  // `ROL=todo`, el default, idéntico al comportamiento de siempre).
  if (SIRVE_TRABAJO_DE_FONDO) {
    // Cola durable: el worker consume los jobs de wa_jobs.
    iniciarWorker(repo, db);

    // Envío de campañas segmentadas (C3.2) y rescate de cotizaciones (Carril D, 1.1):
    // colas independientes de wa_jobs.
    iniciarCampanias();
    iniciarRescate();

    // Recordatorios de cita por WhatsApp (día antes + mismo día). Coordinados por
    // lease de liderazgo entre réplicas `worker` (F6, ver src/red/liderazgo.ts).
    iniciarRecordatorios(repo, db);

    // Reputación en Google (Carril D, 1.3-c): job diario de Places API, solo para
    // tenants Pro con googlePlaceId configurado. No-op sin GOOGLE_PLACES_API_KEY.
    iniciarReputacion(repo, db);

    // Métricas internas: msg/min, latencia del turno del agente, profundidad de cola.
    iniciarReporteMetricas(db);

    // Vigilancia de "bot mudo" (cola atascada, DLQ, tenants sin entrantes en horario,
    // cuota agotada) con alertas a la plataforma. Coordinada por lease (F6).
    iniciarVigilancia(db);
  }
});

// ── Apagado ordenado (deploy con `pm2 reload`, o SIGTERM del sistema) ──
// Deja de aceptar conexiones y de reclamar trabajo, espera los turnos en curso (con tope)
// y sale. PM2 tiene kill_timeout de 30 s (ecosystem.config.cjs). Ver src/red/apagado.ts.
const ESPERA_APAGADO_MS = Number(process.env.APAGADO_ESPERA_MS ?? 25_000);
let saliendo = false;
async function apagar(senal: string): Promise<void> {
  if (saliendo) return;
  saliendo = true;
  console.log(`[server] ${senal}: apagado ordenado (${tareasEnCurso()} tarea(s) en curso, espera máx ${ESPERA_APAGADO_MS} ms)…`);
  server.close();
  server.closeIdleConnections?.();
  const terminaron = await esperarTareas(ESPERA_APAGADO_MS);
  if (!terminaron) console.warn("[server] quedaron tareas sin terminar: el reaper las retoma al volver.");
  process.exit(0);
}
process.once("SIGINT", () => void apagar("SIGINT"));
process.once("SIGTERM", () => void apagar("SIGTERM"));
