import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { msFromEnv } from "../../platform/net/timeouts";
import { log } from "../../platform/observability/log";
import { enqueue, PermanentJobError, type JobContext } from "../../platform/queue";
import type { MarketingSendInput, MarketingSendOutcome } from "../whatsapp";
import { campaigns, campaignSends, type Campaign } from "./schema";
import { CAMPAIGN_DISPATCH_JOB, type CampaignDispatchPayload } from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Despacho de una campaña por la cola genérica (`campaign.dispatch`; la cola de campañas
// aparte del sistema viejo ya no hace falta: la nueva tiene fairness por negocio, pausa por
// cobro y un job en vuelo por `groupKey`).
//
// Cada job manda un LOTE (`CAMPAIGN_BATCH_SIZE`) con una pausa entre envíos
// (`CAMPAIGN_SEND_INTERVAL_MS`: lejos del tope de Meta y para no "spamear" de golpe) y, si
// queda algo, encola el siguiente lote con el mismo `groupKey` (nunca dos lotes de la misma
// campaña a la vez). Cada envío:
//   1. se reclama con FOR UPDATE SKIP LOCKED (pending → processing, intentos + 1);
//   2. lo manda el módulo WhatsApp, que re-chequea el consentimiento (sin él: `skipped`);
//   3. falla transitoria con intentos → vuelve a pending; si no, `failed` con el motivo.
// Un token de WhatsApp inválido corta la campaña (todos los demás fallarían igual).
// Un envío que quedó en `processing` porque el proceso murió a mitad vuelve a pending a los
// 10 minutos (en el peor caso, ese cliente recibe la promoción dos veces).
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = () => Math.max(1, Math.floor(msFromEnv("CAMPAIGN_BATCH_SIZE", 25)));
const SEND_INTERVAL_MS = () => msFromEnv("CAMPAIGN_SEND_INTERVAL_MS", 1000);
const MAX_SEND_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 10 * 60_000;

export interface DispatchDeps {
  /** Manda la promoción a un cliente (el módulo WhatsApp; nunca lanza). */
  send: (db: Executor, businessId: string, input: MarketingSendInput) => Promise<MarketingSendOutcome>;
  /** Pausa entre envíos (los tests la anulan). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type DispatchOutcome = "not_found" | "finished" | "waiting" | "batch_sent" | "completed";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function claimNext(db: Executor, businessId: string, campaignId: string): Promise<{ id: string; clientId: string; attempts: number } | null> {
  return withTenant(db, businessId, async (tx) => {
    const rows = rowsOf<{ id: string; client_id: string; attempts: number }>(
      await tx.execute(sql`
        SELECT id, client_id, attempts FROM ${campaignSends}
         WHERE business_id = ${businessId} AND campaign_id = ${campaignId} AND status = 'pending'
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`),
    );
    const row = rows[0];
    if (!row) return null;
    await tx.update(campaignSends).set({ status: "processing", attempts: row.attempts + 1 }).where(eq(campaignSends.id, row.id));
    return { id: row.id, clientId: row.client_id, attempts: row.attempts + 1 };
  });
}

async function finishSend(db: Executor, businessId: string, sendId: string, changes: Partial<typeof campaignSends.$inferInsert>): Promise<void> {
  await withTenant(db, businessId, (tx) => tx.update(campaignSends).set(changes).where(and(eq(campaignSends.businessId, businessId), eq(campaignSends.id, sendId))));
}

async function loadCampaign(db: Executor, businessId: string, campaignId: string): Promise<Campaign | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx.select().from(campaigns).where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, campaignId))).limit(1),
  );
  return row ?? null;
}

async function remaining(db: Executor, businessId: string, campaignId: string): Promise<number> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(and(eq(campaignSends.businessId, businessId), eq(campaignSends.campaignId, campaignId), inArray(campaignSends.status, ["pending", "processing"]))),
  );
  return Number(row?.n ?? 0);
}

/** Corre un `campaign.dispatch`: un lote de envíos de una campaña. */
export async function handleCampaignDispatchJob(rawPayload: unknown, ctx: JobContext, deps: DispatchDeps): Promise<DispatchOutcome> {
  const p = rawPayload as Partial<CampaignDispatchPayload> | null;
  const businessId = ctx.businessId;
  if (!businessId || typeof p?.campaignId !== "string") throw new PermanentJobError("campaign.dispatch: payload inválido");
  const campaignId = p.campaignId;
  const db = ctx.db;
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? defaultSleep;

  const campaign = await loadCampaign(db, businessId, campaignId);
  if (!campaign) return "not_found";
  if (campaign.status === "completed" || campaign.status === "cancelled" || campaign.status === "draft") return "finished";
  if (campaign.status === "scheduled") {
    if (campaign.scheduledFor && campaign.scheduledFor.getTime() > now().getTime()) return "waiting";
    await withTenant(db, businessId, (tx) =>
      tx
        .update(campaigns)
        .set({ status: "sending", startedAt: now() })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "scheduled"))),
    );
  }

  // Envíos que quedaron a medio camino (el proceso murió con el lote en curso).
  await withTenant(db, businessId, (tx) =>
    tx
      .update(campaignSends)
      .set({ status: "pending" })
      .where(
        and(
          eq(campaignSends.campaignId, campaignId),
          eq(campaignSends.status, "processing"),
          lt(campaignSends.updatedAt, new Date(now().getTime() - STALE_PROCESSING_MS)),
        ),
      ),
  );

  let stopReason: string | null = null;
  for (let i = 0; i < BATCH_SIZE(); i++) {
    // Cancelada a mitad del lote: se corta acá.
    if ((await loadCampaign(db, businessId, campaignId))?.status !== "sending") return "finished";
    const claim = await claimNext(db, businessId, campaignId);
    if (!claim) break;
    if (i > 0) await sleep(SEND_INTERVAL_MS());
    const outcome = await deps.send(db, businessId, { clientId: claim.clientId, message: campaign.message, campaignName: campaign.name });
    if (outcome.status === "sent") {
      await finishSend(db, businessId, claim.id, { status: "sent", sentAt: now(), error: null });
    } else if (outcome.status === "skipped") {
      await finishSend(db, businessId, claim.id, { status: "skipped", error: outcome.reason });
    } else if (outcome.transient && claim.attempts < MAX_SEND_ATTEMPTS) {
      await finishSend(db, businessId, claim.id, { status: "pending", error: outcome.reason });
    } else {
      await finishSend(db, businessId, claim.id, { status: "failed", error: outcome.reason });
      if (outcome.reason === "token_invalid") {
        stopReason = outcome.reason;
        break;
      }
    }
  }

  if (stopReason) {
    await withTenant(db, businessId, (tx) =>
      tx
        .update(campaignSends)
        .set({ status: "failed", error: stopReason })
        .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.status, "pending"))),
    );
    log.warn("campaign_stopped", { businessId, campaignId, reason: stopReason });
  }

  if ((await remaining(db, businessId, campaignId)) === 0) {
    await withTenant(db, businessId, (tx) =>
      tx
        .update(campaigns)
        .set({ status: "completed", completedAt: now() })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "sending"))),
    );
    log.info("campaign_completed", { businessId, campaignId });
    return "completed";
  }

  // Queda trabajo: el siguiente lote, después de la pausa. La clave lleva el id de ESTE job:
  // un reintento de este mismo job no encola dos veces el siguiente.
  await enqueue<CampaignDispatchPayload>(db, {
    type: CAMPAIGN_DISPATCH_JOB,
    businessId,
    payload: { campaignId },
    runAfter: new Date(now().getTime() + SEND_INTERVAL_MS()),
    dedupeKey: `campaign:${campaignId}:after:${ctx.jobId}`,
    groupKey: `campaign:${campaignId}`,
  });
  return "batch_sent";
}
