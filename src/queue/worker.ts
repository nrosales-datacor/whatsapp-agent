import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Repositorio } from "../types";
import { obtenerTenantPorPhoneNumberId } from "../config/tenantStore";
import { responderEntrante } from "../handleWebhook";
import { capturarError } from "../observabilidad/sentry";
import { marcarFalloOReintentar, marcarHecho, purgarJobsHechos, reencolarVencidos, reclamarUno, type Job } from "./cola";
import { purgarWebhooksCrudos } from "../db/webhooksCrudos";
import { log } from "../observabilidad/log";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de la cola durable (ROADMAP B1).
//
// Loops de trabajo (E7): WORKER_CONCURRENCIA slots en paralelo (default 4). Cada
// slot reclama un job, corre responderEntrante y marca hecho/error. Antes había UN
// solo loop serial para TODOS los tenants (techo de 12-30 msg/min en total); un
// turno lento del agente de un negocio frenaba a los demás. El orden por
// conversación y el reparto por tenant NO los garantiza este archivo sino el claim
// (`reclamarUno`, src/queue/cola.ts): máximo un job "procesando" por conversación
// y prioridad al tenant con menos jobs en vuelo — así vale igual entre slots del
// mismo proceso que entre réplicas `ROL=worker`.
// Loop reaper: cada 60 s reencola jobs zombis (crashed mientras procesaban).
// Loop de purga (ROADMAP F11): cada JOBS_PURGA_INTERVALO_MIN minutos borra los
// "hecho" más viejos que JOBS_RETENCION_DIAS. Intervalo propio y mucho más
// espaciado que el del reaper a propósito: son loops de distinta frecuencia y
// criticidad (el reaper protege la entrega de mensajes en curso; la purga es
// higiene de una tabla que ya terminó su trabajo) — no se mezclan.
//
// Para escalar más allá de un proceso: subir WORKER_CONCURRENCIA o correr más
// réplicas `ROL=worker` (DEPLOY.md §21). Ojo con el pool (DB_POOL_MAX): cada slot
// usa una conexión solo mientras consulta (no mientras espera al LLM), así que 4
// slots conviven bien con el default de 10.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

const POLL_MS = Number(process.env.QUEUE_POLL_MS ?? 1000);
const REAPER_INTERVAL_MS = 60_000;
// ALTO-12 (ROADMAP F11): el reaper NO debe reencolar un job que sigue vivo y
// legítimamente lento — eso duplicaría la respuesta al cliente (ver la
// semántica at-least-once documentada arriba). El umbral tiene que cubrir el
// PEOR CASO del turno del agente, no el caso típico:
//   - runAgent.ts: MAX_PASOS = 4 iteraciones de tool-calling; cada una hace UNA
//     llamada a OpenAI con TIMEOUT_OPENAI_MS = 20s (src/red/timeouts.ts) y
//     OPENAI_MAX_REINTENTOS = 1 → hasta 2 intentos ⇒ ~40s por paso en el peor
//     caso. Varios pasos también disparan una tool que llama a Google Calendar
//     (TIMEOUT_GOOGLE_MS = 15s). Peor caso del loop completo: 4 × (40s + 15s)
//     ≈ 220s.
//   - El envío final por WhatsApp (whatsapp/client.ts) reintenta hasta
//     MAX_INTENTOS_ENVIO = 3 veces con TIMEOUT_GRAPH_MS = 15s c/u más backoff
//     entre intentos (500ms, 1500ms) ⇒ ~47s por envío, y un turno puede mandar
//     más de un mensaje (confirmación + lista de horarios).
//   → Peor caso total de UN job: ~220s + 47s ≈ 267s, ya por ENCIMA de los 180s
//   originales. O sea que el umbral viejo estaba corto incluso sin E7: un turno
//   que agotara reintentos en varios pasos podía reencolarse mientras seguía
//   vivo. Subido a 360s (6 min) para dejar margen real (~90-100s) sobre ese
//   peor caso, sin ser tan grande como para tardar demasiado en rescatar un job
//   realmente colgado (crash real del proceso).
//   El worker concurrente de E7 no cambia esta cuenta (el peor caso de UN job
//   es el mismo esté o no compartiendo proceso con otros); lo que sí cambia es
//   que, si el PROCESO ENTERO se cuelga, más jobs "procesando" en paralelo
//   vencen juntos — eso es un pico de reintentos simultáneo, no un problema de
//   umbral insuficiente por job, y no lo resuelve mover este número.
const REAPER_UMBRAL_SEG = Number(process.env.QUEUE_REAPER_UMBRAL_SEG ?? 360);
const PURGA_INTERVAL_MS = Number(process.env.JOBS_PURGA_INTERVALO_MIN ?? 60) * 60_000;
const JOBS_RETENCION_DIAS = Number(process.env.JOBS_RETENCION_DIAS ?? 7);

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CONCURRENCIA_DEFAULT = 4;

/** Slots de trabajo en paralelo por proceso (E7). Entero ≥ 1; cualquier otra cosa → default. */
export function concurrenciaWorker(): number {
  const n = Number(process.env.WORKER_CONCURRENCIA);
  return Number.isInteger(n) && n >= 1 ? n : CONCURRENCIA_DEFAULT;
}

/**
 * Procesa UN job ya reclamado (estado "procesando") y lo cierra: "hecho" si el turno
 * terminó (bien, o con la disculpa del último intento), o de vuelta a "pendiente"
 * con backoff / "error" si lanzó. Separado del loop para poder probarlo contra
 * PGlite sin levantar los slots infinitos.
 *
 * El número de intento viaja a `responderEntrante` (E7): con él decide si un error
 * transitorio se relanza (la cola reintenta) o si es el último intento y toca
 * disculparse con el cliente y avisar al operador.
 */
export async function procesarJob(job: Job, repo: Repositorio, db: DB): Promise<void> {
  // F14: correlationId/conversacionId viajan gratis dentro de job.payload
  // (JSONB) desde la ingesta — ver PendienteSerializado.correlationId.
  const correlationId = job.payload.correlationId;
  const conversacionId = job.payload.conv?.id;
  log.info("job_reclamado", { correlationId, tenantId: job.tenantId, jobId: job.id, conversacionId });

  // Reconstruir Pendiente: tenant se relee del caché (no se serializa para
  // evitar datos sensibles en la base y para tener siempre la config vigente).
  const tenant = obtenerTenantPorPhoneNumberId(job.payload.entrante.phoneNumberId);
  if (!tenant) {
    // El tenant fue dado de baja después de que se encoló el mensaje.
    await marcarHecho(db, job.id);
    console.warn(`[worker] job ${job.id}: tenant ${job.tenantId} no encontrado, descartado`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendiente = { ...job.payload, tenant } as any;
  try {
    await responderEntrante(pendiente, repo, db, { numero: job.intentos, max: job.maxIntentos });
    await marcarHecho(db, job.id);
    log.info("job_completado", { correlationId, tenantId: job.tenantId, jobId: job.id, conversacionId });
  } catch (e) {
    // La alerta ante error definitivo (agotó reintentos) vive DENTRO de
    // marcarFalloOReintentar (src/queue/cola.ts, ROADMAP F11): umbral por
    // TENANT con ventana y cooldown, no un capturarError por cada job — ver
    // el comentario de esa función para el porqué (con 50 tenants, un
    // evento de Sentry por job agotado sería ruido; el job individual ya
    // queda visible en el DLQ, `GET admin/dlq`).
    await marcarFalloOReintentar(db, job.id, String(e), job.intentos, job.maxIntentos, job.tenantId);
    log.warn("job_fallido", {
      correlationId,
      tenantId: job.tenantId,
      jobId: job.id,
      conversacionId,
      intentos: job.intentos,
      maxIntentos: job.maxIntentos,
      error: String(e),
    });
    console.error(`[worker] job ${job.id} falló (intento ${job.intentos}/${job.maxIntentos}):`, e);
  }
}

export function iniciarWorker(repo: Repositorio, db: DB, concurrencia = concurrenciaWorker()): void {
  const loopTrabajo = async (slot: number) => {
    // Arranque escalonado: que los N slots no le peguen a la base todos en el mismo
    // milisegundo de cada poll cuando la cola está vacía.
    await dormir(Math.floor((POLL_MS * slot) / concurrencia));
    while (true) {
      try {
        const job = await reclamarUno(db);
        if (!job) {
          await dormir(POLL_MS);
          continue;
        }
        await procesarJob(job, repo, db);
      } catch (e) {
        console.error(`[worker] error en loop de trabajo (slot ${slot}):`, e);
        capturarError(e, { loop: "trabajo", slot });
        await dormir(POLL_MS);
      }
    }
  };

  const loopReaper = async () => {
    while (true) {
      await dormir(REAPER_INTERVAL_MS);
      try {
        const n = await reencolarVencidos(db, REAPER_UMBRAL_SEG);
        if (n > 0) console.log(`[worker] reaper: ${n} job(s) vencido(s) reencolado(s)`);
      } catch (e) {
        console.error("[worker] reaper error:", e);
        capturarError(e, { loop: "reaper" });
      }
    }
  };

  // Loop de purga (ROADMAP F11 + F3): intervalo propio, mucho más espaciado que el
  // reaper (higiene, no recuperación de trabajo en curso). Mismo tratamiento de
  // errores: un fallo se loguea y va a Sentry, nunca tumba el loop. Reusa el
  // mismo intervalo/retención que wa_jobs para wa_webhooks_crudos (mismo patrón
  // de F11, no uno nuevo): ambas tablas son "cola procesada", misma higiene.
  const loopPurga = async () => {
    while (true) {
      await dormir(PURGA_INTERVAL_MS);
      try {
        const n = await purgarJobsHechos(db, JOBS_RETENCION_DIAS);
        if (n > 0) console.log(`[worker] purga: ${n} job(s) "hecho" borrado(s) (retención ${JOBS_RETENCION_DIAS}d)`);
      } catch (e) {
        console.error("[worker] purga error:", e);
        capturarError(e, { loop: "purga" });
      }
      try {
        const n = await purgarWebhooksCrudos(db, JOBS_RETENCION_DIAS);
        if (n > 0) console.log(`[worker] purga: ${n} fila(s) "procesado/descartado" de wa_webhooks_crudos borrada(s) (retención ${JOBS_RETENCION_DIAS}d)`);
      } catch (e) {
        console.error("[worker] purga de wa_webhooks_crudos error:", e);
        capturarError(e, { loop: "purga", tabla: "wa_webhooks_crudos" });
      }
    }
  };

  for (let slot = 0; slot < concurrencia; slot++) {
    loopTrabajo(slot).catch((e) => {
      console.error(`[worker] loop de trabajo (slot ${slot}) terminó inesperadamente:`, e);
      capturarError(e, { loop: "trabajo", slot, fatal: true });
    });
  }
  loopReaper().catch((e) => {
    console.error("[worker] loop reaper terminó inesperadamente:", e);
    capturarError(e, { loop: "reaper", fatal: true });
  });
  loopPurga().catch((e) => {
    console.error("[worker] loop purga terminó inesperadamente:", e);
    capturarError(e, { loop: "purga", fatal: true });
  });
  console.log(
    `Worker de cola iniciado (${concurrencia} slot(s) en paralelo, poll cada ${POLL_MS}ms, reaper cada ${REAPER_INTERVAL_MS / 1000}s, purga cada ${
      PURGA_INTERVAL_MS / 60_000
    }min).`,
  );
}
