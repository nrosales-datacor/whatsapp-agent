import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Repositorio } from "../types";
import { obtenerTenantPorPhoneNumberId } from "../config/tenantStore";
import { responderEntrante } from "../handleWebhook";
import { marcarFalloOReintentar, marcarHecho, reencolarVencidos, reclamarUno } from "./cola";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de la cola durable (ROADMAP B1).
//
// Loop de trabajo: reclama un job a la vez (serial → preserva orden por
// conversación en el piloto), corre responderEntrante y marca hecho/error.
// Loop reaper: cada 60 s reencola jobs zombis (crashed mientras procesaban).
//
// Para escalar a concurrencia: lanzar iniciarWorker varias veces en el mismo
// proceso, o shardear por tenantId. La cola (SKIP LOCKED) lo soporta sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

const POLL_MS = Number(process.env.QUEUE_POLL_MS ?? 1000);
const REAPER_INTERVAL_MS = 60_000;
const REAPER_UMBRAL_SEG = Number(process.env.QUEUE_REAPER_UMBRAL_SEG ?? 180);

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
          await responderEntrante(pendiente, repo);
          await marcarHecho(db, job.id);
        } catch (e) {
          await marcarFalloOReintentar(db, job.id, String(e), job.intentos, job.maxIntentos);
          console.error(`[worker] job ${job.id} falló (intento ${job.intentos}/${job.maxIntentos}):`, e);
        }
      } catch (e) {
        console.error("[worker] error en loop de trabajo:", e);
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
      }
    }
  };

  loopTrabajo().catch((e) => console.error("[worker] loop de trabajo terminó inesperadamente:", e));
  loopReaper().catch((e) => console.error("[worker] loop reaper terminó inesperadamente:", e));
  console.log(`Worker de cola iniciado (poll cada ${POLL_MS}ms, reaper cada ${REAPER_INTERVAL_MS / 1000}s).`);
}
