import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantPolicy } from "../db/rls";

// ─────────────────────────────────────────────────────────────────────────────
// Cola durable de trabajos en Postgres (motor en ./worker.ts, encolado en ./enqueue.ts).
//
// Una fila = un trabajo de fondo de un `type` (p. ej. "email.send", "whatsapp.reply").
// Los efectos externos (WhatsApp, Google Calendar, correo) salen SIEMPRE por acá
// (PLAN-GESTION.md §2): el job se inserta en la MISMA transacción que la escritura de
// dominio (patrón outbox), así o quedan los dos o ninguno.
//
// Ciclo de vida (`status`):
//   pending → running → done
//                     ↘ failed (falló un intento; se reintenta cuando llega `run_after`)
//                     ↘ dead   (sin más intentos, o error permanente: DLQ, se revisa a mano)
// `failed` es reclamable igual que `pending` (cuando vence su backoff); se distingue para
// poder contar "cuántos están reintentando" sin mirar `attempts`.
//
// RLS: `business_id` null = job de SISTEMA (solo lo ve/escribe `withSystem`). Un job de un
// negocio lo puede insertar una transacción `withTenant` de ese negocio (outbox) y ningún
// otro negocio lo ve. Los workers reclaman con `withSystem` (cross-tenant por diseño).
// ─────────────────────────────────────────────────────────────────────────────

export const JOB_STATUSES = ["pending", "running", "done", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null = job de sistema (no pertenece a ningún negocio). Sin FK a propósito: la cola es
    // plataforma y no depende del esquema de los módulos.
    businessId: uuid("business_id"),
    // Tipo del job en minúsculas con punto, p. ej. "email.send". Elige el handler.
    type: text("type").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    // Intentos YA empezados (se suma al reclamar: un crash a mitad también consume uno).
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    // No se reclama antes de esto (encolado diferido y backoff de los reintentos).
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    // Último reclamo (o latido) del worker que lo tiene. Con `running`, un `locked_at`
    // viejo = el worker murió o se colgó → la recuperación lo libera. En los demás estados
    // queda como "cuándo se reclamó por última vez" (lo usa el reparto entre negocios).
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Id del worker que lo tiene ("host:pid:azar"), solo mientras está `running`.
    lockedBy: text("locked_by"),
    // Datos del job (JSON). Sin secretos; con los mínimos datos personales posibles: mejor
    // ids que contenidos (el handler relee lo que necesita).
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    // Último error visto (recortado). Se conserva aunque un reintento posterior salga bien.
    lastError: text("last_error"),
    // Idempotencia: el mismo (negocio, dedupe_key) no se encola dos veces mientras la fila
    // exista (la purga de terminados la libera). null = sin deduplicación.
    dedupeKey: text("dedupe_key"),
    // Exclusión mutua: como mucho UN job `running` por (negocio, group_key), p. ej. una
    // conversación. null = sin grupo.
    groupKey: text("group_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("jobs_status_check", sql`${t.status} IN ('pending', 'running', 'done', 'failed', 'dead')`),
    check("jobs_max_attempts_check", sql`${t.maxAttempts} >= 1`),
    // Claim: los reclamables, por orden de `run_after`. Parcial: los terminados no pesan.
    index("jobs_ready_idx").on(t.runAfter).where(sql`status IN ('pending', 'failed')`),
    // En vuelo: conteo por negocio (reparto), exclusión por grupo y recuperación de locks.
    index("jobs_running_idx").on(t.businessId, t.groupKey).where(sql`status = 'running'`),
    // Reparto entre negocios: último reclamo de cada negocio.
    index("jobs_business_locked_idx").on(t.businessId, t.lockedAt),
    // DLQ y purga por antigüedad de los terminados.
    index("jobs_finished_idx").on(t.status, t.finishedAt).where(sql`status IN ('done', 'dead')`),
    // Deduplicación por negocio, y aparte la de los jobs de sistema (en un índice único
    // los NULL no chocan entre sí: sin el segundo índice, dos jobs de sistema con la misma
    // clave entrarían los dos). `enqueue` usa ON CONFLICT DO NOTHING sin target: cubre ambos.
    uniqueIndex("jobs_business_dedupe_key_unique")
      .on(t.businessId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND business_id IS NOT NULL`),
    uniqueIndex("jobs_system_dedupe_key_unique").on(t.dedupeKey).where(sql`dedupe_key IS NOT NULL AND business_id IS NULL`),
    tenantPolicy(),
  ],
).enableRLS();
