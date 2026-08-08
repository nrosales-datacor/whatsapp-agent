import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Repositorio } from "../types";
import { obtenerTenantPorPhoneNumberId } from "../config/tenantStore";
import { responderEntrante } from "../handleWebhook";
import { capturarError } from "../observabilidad/sentry";
import { marcarFalloOReintentar, marcarHecho, purgarJobsHechos, reencolarVencidos, reclamarUno } from "./cola";
import { purgarWebhooksCrudos } from "../db/webhooksCrudos";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de la cola durable (ROADMAP B1).
//
// Loop de trabajo: reclama un job a la vez (serial → preserva orden por
// conversación en el piloto), corre responderEntrante y marca hecho/error.
// Loop reaper: cada 60 s reencola jobs zombis (crashed mientras procesaban).
// Loop de purga (ROADMAP F11): cada JOBS_PURGA_INTERVALO_MIN minutos borra los
// "hecho" más viejos que JOBS_RETENCION_DIAS. Intervalo propio y mucho más
// espaciado que el del reaper a propósito: son loops de distinta frecuencia y
// criticidad (el reaper protege la entrega de mensajes en curso; la purga es
// higiene de una tabla que ya terminó su trabajo) — no se mezclan.
//
// Para escalar a concurrencia: lanzar iniciarWorker varias veces en el mismo
// proceso, o shardear por tenantId. La cola (SKIP LOCKED) lo soporta sin cambios.
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

export function iniciarWorker(repo: Repositorio, db: DB): void {
  const loopTrabajo = async () => {
    while (true) {
      try {
        const job = await reclamarUno(db);
        if (!job) {
          await dormir(POLL_MS);
          continue;
        }

        // Reconstruir Pendiente: tenant se relee del caché (no se serializa para
        // evitar datos sensibles en la base y para tener siempre la config vigente).
        const tenant = obtenerTenantPorPhoneNumberId(job.payload.entrante.phoneNumberId);
        if (!tenant) {
          // El tenant fue dado de baja después de que se encoló el mensaje.
          await marcarHecho(db, job.id);
          console.warn(`[worker] job ${job.id}: tenant ${job.tenantId} no encontrado, descartado`);
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pendiente = { ...job.payload, tenant } as any;
        try {
          await responderEntrante(pendiente, repo, db);
          await marcarHecho(db, job.id);
        } catch (e) {
          // La alerta ante error definitivo (agotó reintentos) vive DENTRO de
          // marcarFalloOReintentar (src/queue/cola.ts, ROADMAP F11): umbral por
          // TENANT con ventana y cooldown, no un capturarError por cada job — ver
          // el comentario de esa función para el porqué (con 50 tenants, un
          // evento de Sentry por job agotado sería ruido; el job individual ya
          // queda visible en el DLQ, `GET admin/dlq`).
          await marcarFalloOReintentar(db, job.id, String(e), job.intentos, job.maxIntentos, job.tenantId);
          console.error(`[worker] job ${job.id} falló (intento ${job.intentos}/${job.maxIntentos}):`, e);
        }
      } catch (e) {
        console.error("[worker] error en loop de trabajo:", e);
        capturarError(e, { loop: "trabajo" });
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

  loopTrabajo().catch((e) => {
    console.error("[worker] loop de trabajo terminó inesperadamente:", e);
    capturarError(e, { loop: "trabajo", fatal: true });
  });
  loopReaper().catch((e) => {
    console.error("[worker] loop reaper terminó inesperadamente:", e);
    capturarError(e, { loop: "reaper", fatal: true });
  });
  loopPurga().catch((e) => {
    console.error("[worker] loop purga terminó inesperadamente:", e);
    capturarError(e, { loop: "purga", fatal: true });
  });
  console.log(
    `Worker de cola iniciado (poll cada ${POLL_MS}ms, reaper cada ${REAPER_INTERVAL_MS / 1000}s, purga cada ${
      PURGA_INTERVAL_MS / 60_000
    }min).`,
  );
}
