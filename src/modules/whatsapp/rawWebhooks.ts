import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { withSystem, type Executor } from "../../platform/db/scope";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import { alertPlatform } from "../../platform/observability/alerts";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { rawWebhooks, type RawWebhookReason } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Red de seguridad de la ingesta (`raw_webhooks`, portado de
// legacy/src/{db/webhooksCrudos,reprocesoWebhooks}.ts). Meta no reintenta un webhook que
// respondimos con 200: si el `phone_number_id` todavía no resuelve a ningún canal (un
// negocio que se está dando de alta) o el payload tiene una forma que no sabemos leer, la
// fila de acá es la ÚNICA copia de ese mensaje.
//
//   • Se guarda solo el payload ya verificado por firma, nunca los estados.
//   • Reproceso: un loop con lease (una réplica) reinyecta los pendientes por el MISMO
//     camino de ingesta; también se reprocesan al conectar un número. Lo que se ingesta
//     queda `processed`; lo que sigue sin resolver suma intentos y, al tope, `discarded`.
//   • Purga: lo procesado/descartado se borra pasados unos días.
//   • Alerta a la plataforma si se acumulan pendientes (webhooks que llegan y no rutean).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = () => Math.max(1, Math.floor(msFromEnv("WHATSAPP_RAW_WEBHOOK_MAX_ATTEMPTS", 12)));
const RETENTION_DAYS = () => Math.floor(msFromEnv("WHATSAPP_RAW_WEBHOOK_RETENTION_DAYS", 7));
const ALERT_THRESHOLD = 20;
const BATCH = 100;

export interface RawWebhookInput {
  payload: unknown;
  phoneNumberId: string | null;
  waMessageId: string | null;
  reason: RawWebhookReason;
}

/** Guarda el crudo (sin negocio todavía: contexto de sistema). Un mismo `wamid` no se guarda dos veces. */
export async function saveRawWebhook(db: Executor, input: RawWebhookInput): Promise<void> {
  await withSystem(db, (tx) =>
    tx
      .insert(rawWebhooks)
      .values({ payload: input.payload ?? {}, phoneNumberId: input.phoneNumberId, waMessageId: input.waMessageId, reason: input.reason })
      .onConflictDoNothing(),
  );
}

/** Lo que hizo el reproceso con un payload: se ingestó (o era duplicado) o sigue sin poder. */
export type ReprocessAttempt = "ingested" | "unresolved";

export interface ReprocessResult {
  processed: number;
  discarded: number;
  pending: number;
}

/**
 * Reintenta los pendientes (más viejos primero). `ingest` es el camino normal de la
 * ingesta sin red de seguridad (no vuelve a guardar el crudo). Con `phoneNumberId`, solo
 * los de ese número (recién conectado).
 */
export async function reprocessRawWebhooks(
  db: Executor,
  ingest: (payload: unknown) => Promise<ReprocessAttempt>,
  options: { phoneNumberId?: string; limit?: number } = {},
): Promise<ReprocessResult> {
  const conditions = [eq(rawWebhooks.status, "pending")];
  if (options.phoneNumberId) conditions.push(eq(rawWebhooks.phoneNumberId, options.phoneNumberId));
  const rows = await withSystem(db, (tx) =>
    tx
      .select()
      .from(rawWebhooks)
      .where(and(...conditions))
      .orderBy(asc(rawWebhooks.receivedAt))
      .limit(options.limit ?? BATCH),
  );
  const maxAttempts = MAX_ATTEMPTS();
  let processed = 0;
  let discarded = 0;
  for (const row of rows) {
    let attempt: ReprocessAttempt = "unresolved";
    // Un payload ilegible no se arregla solo: no se reinyecta (solo cuenta el intento).
    if (row.reason !== "unparseable" && row.phoneNumberId) {
      try {
        attempt = await ingest(row.payload);
      } catch (e) {
        log.warn("whatsapp_raw_reprocess_failed", { rawWebhookId: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (attempt === "ingested") {
      await withSystem(db, (tx) => tx.update(rawWebhooks).set({ status: "processed", attempts: row.attempts + 1 }).where(eq(rawWebhooks.id, row.id)));
      processed++;
      continue;
    }
    const attempts = row.attempts + 1;
    const exhausted = attempts >= maxAttempts;
    await withSystem(db, (tx) =>
      tx
        .update(rawWebhooks)
        .set({ attempts, ...(exhausted ? { status: "discarded" } : {}) })
        .where(eq(rawWebhooks.id, row.id)),
    );
    if (exhausted) discarded++;
  }
  return { processed, discarded, pending: rows.length - processed - discarded };
}

/** Borra lo procesado/descartado más viejo que la retención. */
export async function purgeRawWebhooks(db: Executor, retentionDays: number = RETENTION_DAYS(), now: Date = new Date()): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await withSystem(db, (tx) =>
    tx
      .delete(rawWebhooks)
      .where(and(inArray(rawWebhooks.status, ["processed", "discarded"]), lt(rawWebhooks.receivedAt, cutoff)))
      .returning({ id: rawWebhooks.id }),
  );
  return rows.length;
}

async function countPending(db: Executor): Promise<number> {
  const [row] = await withSystem(db, (tx) =>
    tx.select({ n: sql<string>`count(*)` }).from(rawWebhooks).where(eq(rawWebhooks.status, "pending")),
  );
  return Number(row?.n ?? 0);
}

/** Loop de reproceso y purga (procesos `ROLE=worker|all`, una réplica por lease). */
export function startRawWebhookLoop(options: {
  db: Executor;
  ingest: (payload: unknown) => Promise<ReprocessAttempt>;
  intervalMs?: number;
}): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("WHATSAPP_RAW_REPROCESS_INTERVAL_MS", 5 * 60_000);
  return startLeaderLoop({
    db: options.db,
    label: "whatsapp_raw_webhooks",
    intervalMs,
    tick: async () => {
      const result = await reprocessRawWebhooks(options.db, options.ingest);
      const purged = await purgeRawWebhooks(options.db);
      if (result.processed || result.discarded || purged) log.info("whatsapp_raw_reprocess", { ...result, purged });
      const pending = await countPending(options.db);
      if (pending >= ALERT_THRESHOLD) {
        alertPlatform({
          type: "whatsapp_raw_webhooks_pending",
          severity: "warning",
          message: `Hay ${pending} webhooks de WhatsApp sin rutear (número sin canal o payload ilegible). Revisá raw_webhooks.`,
          data: { pending },
        });
      }
    },
    onError: (e, phase) => {
      log.error("whatsapp_raw_reprocess_error", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "whatsapp_raw_webhooks", phase });
    },
    scalingHint: "Revisá el índice raw_webhooks_status_received_idx o subí WHATSAPP_RAW_REPROCESS_INTERVAL_MS.",
  });
}
