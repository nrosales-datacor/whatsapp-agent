import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import { isTransientError } from "../../platform/net/transient";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { enqueue, PermanentJobError, type JobContext } from "../../platform/queue";
import { getClient } from "../clients";
import { getAppointment, listCompletedAppointmentsEndedBetween } from "../scheduling";
import { channelForLocation, credentialsOf, listConnectedWhatsAppBusinessIds } from "./channels";
import type { FollowUpReply } from "./commands";
import { ensureConversation, lastInboundAt, saveOutgoingMessage } from "./conversations";
import { loadTextProfile, type WhatsAppDeps } from "./deps";
import type { GrowthResolver } from "./growth";
import { readGrowthConfig } from "./growthSettings";
import { followUpButtonIds } from "./payload";
import { windowState } from "./rules";
import { followUps, type FollowUpSentiment } from "./schema";
import { BUTTON_TITLES, pipelineText, type PipelineTextKey } from "./texts";
import { incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Seguimiento post-servicio con pedido de reseña (I6.2, portado del C3.1 viejo y arreglado
// según AUDIT-v2 V2-02: antes no tenía plantilla y fuera de la ventana de 24 h no llegaba).
//
//   1. Barrido (loop con lease, una réplica): por cada negocio con WhatsApp conectado, con
//      `reviews` en el plan y el seguimiento activado, las citas COMPLETADAS que terminaron
//      hace entre `delayHours` y 48 h sin seguimiento → un job por cita (dedupe por cita).
//   2. Job: re-chequea (cita completada, cliente con teléfono, sin baja de promociones),
//      reclama la fila de `follow_ups` (única por cita: nunca dos seguimientos) y manda
//      "¿Cómo te fue?" con botones Excelente / Bien / Mal si la ventana de 24 h está
//      abierta, o la plantilla `followUp` del número (con los mismos tres botones como
//      payload) si no. Sin plantilla y fuera de la ventana no se manda (se libera la fila).
//   3. Respuesta (acción directa del pipeline, ./pipeline.ts): Excelente → link de reseñas
//      de Google (si el negocio lo cargó); Bien → gracias; Mal → disculpas, la conversación
//      pasa a una persona y se avisa al equipo, antes de que termine en una reseña mala.
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_FOLLOW_UP_JOB = "whatsapp.follow_up";

/** No se pide opinión de una cita que terminó hace más de esto. */
const MAX_AGE_HOURS = 48;

export interface FollowUpJobPayload {
  appointmentId: string;
}

// ── 1. Barrido ──────────────────────────────────────────────────────────────

/** Encola los seguimientos que tocan. Devuelve cuántos encoló. */
export async function sweepFollowUps(db: Executor, getGrowth: GrowthResolver, now: Date = new Date()): Promise<{ enqueued: number }> {
  let enqueued = 0;
  for (const businessId of await listConnectedWhatsAppBusinessIds(db)) {
    if (!(await getGrowth(businessId)).reviews) continue;
    const config = (await readGrowthConfig(db, businessId)).reviews;
    if (!config.enabled) continue;
    const to = new Date(now.getTime() - config.delayHours * 3_600_000);
    const from = new Date(now.getTime() - MAX_AGE_HOURS * 3_600_000);
    if (to <= from) continue;
    const due = await listCompletedAppointmentsEndedBetween(db, businessId, { from, to });
    if (due.length === 0) continue;
    const done = await withTenant(db, businessId, (tx) =>
      tx
        .select({ appointmentId: followUps.appointmentId })
        .from(followUps)
        .where(and(eq(followUps.businessId, businessId), inArray(followUps.appointmentId, due.map((a) => a.id)))),
    );
    const skip = new Set(done.map((d) => d.appointmentId));
    for (const appointment of due) {
      if (skip.has(appointment.id)) continue;
      const result = await enqueue<FollowUpJobPayload>(db, {
        type: WHATSAPP_FOLLOW_UP_JOB,
        businessId,
        payload: { appointmentId: appointment.id },
        dedupeKey: `follow-up:${appointment.id}`,
        maxAttempts: 3,
      });
      if (result.created) enqueued++;
    }
  }
  return { enqueued };
}

export function startFollowUpLoop(options: { db: Executor; getGrowth: GrowthResolver; intervalMs?: number }): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("WHATSAPP_FOLLOW_UP_INTERVAL_MS", 10 * 60_000);
  return startLeaderLoop({
    db: options.db,
    label: "whatsapp_follow_ups",
    intervalMs,
    tick: async () => {
      const result = await sweepFollowUps(options.db, options.getGrowth);
      if (result.enqueued > 0) log.info("whatsapp_follow_ups_sweep", result);
    },
    onError: (e, phase) => {
      log.error("whatsapp_follow_ups_sweep_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "whatsapp_follow_ups", phase });
    },
    scalingHint: "Subí WHATSAPP_FOLLOW_UP_INTERVAL_MS o revisá el índice de citas por fecha.",
  });
}

// ── 2. Envío ────────────────────────────────────────────────────────────────

export type FollowUpOutcome = "sent_buttons" | "sent_template" | "skipped" | "no_template" | "failed";

async function releaseClaim(db: Executor, businessId: string, appointmentId: string): Promise<void> {
  await withTenant(db, businessId, (tx) =>
    tx.delete(followUps).where(and(eq(followUps.businessId, businessId), eq(followUps.appointmentId, appointmentId), isNull(followUps.sentiment))),
  );
}

/** Corre un `whatsapp.follow_up`. */
export async function handleFollowUpJob(rawPayload: unknown, ctx: JobContext, deps: WhatsAppDeps): Promise<FollowUpOutcome> {
  const p = rawPayload as Partial<FollowUpJobPayload> | null;
  const businessId = ctx.businessId;
  if (!businessId || typeof p?.appointmentId !== "string") throw new PermanentJobError("whatsapp.follow_up: payload inválido");
  const appointmentId = p.appointmentId;
  const db = ctx.db;

  // El plan o la configuración pudieron cambiar desde el barrido.
  if (!(await deps.getGrowth(businessId)).reviews || !(await readGrowthConfig(db, businessId)).reviews.enabled) return "skipped";
  const appointment = await getAppointment(db, businessId, appointmentId);
  if (!appointment || appointment.status !== "completed") return "skipped";
  const client = await getClient(db, businessId, appointment.clientId);
  // Quien pidió no recibir promociones tampoco recibe el pedido de reseña.
  if (!client?.phone || client.anonymized || client.marketingOptOutAt) return "skipped";
  const channel = await channelForLocation(db, businessId, appointment.locationId);
  const credentials = channel ? credentialsOf(channel) : null;
  if (!channel || !credentials) return "skipped";

  const now = deps.now();
  // Reclamo: la fila es única por cita (un reintento o dos réplicas no mandan dos).
  const claimed = await withTenant(db, businessId, (tx) =>
    tx
      .insert(followUps)
      .values({ businessId, appointmentId, sentAt: now })
      .onConflictDoNothing({ target: followUps.appointmentId })
      .returning({ id: followUps.id }),
  );
  if (claimed.length === 0) return "skipped";

  const conversation = await ensureConversation(db, businessId, channel.id, client.id);
  const win = windowState(await lastInboundAt(db, businessId, conversation.id), now);
  const services = appointment.services.map((s) => s.name).join(" + ") || "tu cita";
  const ids = followUpButtonIds(appointmentId);
  try {
    if (win.open) {
      const texts = await loadTextProfile(db, businessId);
      const body = pipelineText(texts, "followUpQuestion", { cliente: client.name, servicio: services });
      await deps.api.sendButtons(credentials, client.phone, body, [
        { id: ids.positive, title: BUTTON_TITLES.followUpPositive },
        { id: ids.neutral, title: BUTTON_TITLES.followUpNeutral },
        { id: ids.negative, title: BUTTON_TITLES.followUpNegative },
      ]);
      await saveOutgoingMessage(db, businessId, conversation.id, {
        content: `${body}\n[${BUTTON_TITLES.followUpPositive} / ${BUTTON_TITLES.followUpNeutral} / ${BUTTON_TITLES.followUpNegative}]`,
        at: now,
      });
      await incrementAiUsage(db, businessId, { messagesOut: 1 }, now);
      log.info("whatsapp_follow_up_sent", { businessId, appointmentId, via: "buttons" });
      return "sent_buttons";
    }
    const template = channel.templates?.followUp;
    if (!template) {
      await releaseClaim(db, businessId, appointmentId);
      log.info("whatsapp_follow_up_no_template", { businessId, appointmentId });
      return "no_template";
    }
    await deps.api.sendTemplate(credentials, client.phone, {
      name: template.name,
      language: template.language,
      bodyParams: [client.name, services],
      quickReplyPayloads: [ids.positive, ids.neutral, ids.negative],
    });
    await saveOutgoingMessage(db, businessId, conversation.id, { content: `⭐ Seguimiento post-servicio (plantilla "${template.name}"): ${services}.`, at: now });
    await incrementAiUsage(db, businessId, { messagesOut: 1, utilityTemplates: 1 }, now);
    log.info("whatsapp_follow_up_sent", { businessId, appointmentId, via: "template" });
    return "sent_template";
  } catch (e) {
    // No salió: se libera la fila para que un reintento (o nadie) lo haga.
    await releaseClaim(db, businessId, appointmentId);
    if (isTransientError(e) && !ctx.isLastAttempt) throw e;
    log.warn("whatsapp_follow_up_failed", { businessId, appointmentId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return "failed";
  }
}

// ── 3. Respuesta ────────────────────────────────────────────────────────────

/** Qué contestarle al cliente y qué hacer después (lo ejecuta el pipeline). */
export interface FollowUpAnswerPlan {
  text: PipelineTextKey;
  vars: Record<string, string>;
  /** Pasar la conversación a una persona y avisar al equipo ("Mal"). */
  escalate: boolean;
}

/**
 * Registra la respuesta al seguimiento de una cita DEL cliente y decide la contestación.
 * Solo cuenta la primera respuesta (un segundo toque no vuelve a pedir la reseña ni a
 * avisar al equipo). Una cita que no es suya o sin seguimiento: solo un gracias.
 */
export async function recordFollowUpAnswer(
  db: Executor,
  businessId: string,
  clientId: string,
  reply: FollowUpReply,
  options: { reviewUrl: string | null; reviewsEnabled: boolean; at: Date },
): Promise<FollowUpAnswerPlan> {
  const appointment = await getAppointment(db, businessId, reply.appointmentId);
  if (!appointment || appointment.clientId !== clientId) return { text: "followUpPositive", vars: {}, escalate: false };
  const askReview = reply.answer === "positive" && options.reviewsEnabled && Boolean(options.reviewUrl);
  const updated = await withTenant(db, businessId, (tx) =>
    tx
      .update(followUps)
      .set({ sentiment: reply.answer satisfies FollowUpSentiment, reviewRequested: askReview, updatedAt: options.at })
      .where(and(eq(followUps.businessId, businessId), eq(followUps.appointmentId, reply.appointmentId), isNull(followUps.sentiment)))
      .returning({ id: followUps.id }),
  );
  const first = updated.length > 0;
  if (reply.answer === "positive") {
    return askReview && first ? { text: "followUpPositiveReview", vars: { link: options.reviewUrl as string }, escalate: false } : { text: "followUpPositive", vars: {}, escalate: false };
  }
  if (reply.answer === "neutral") return { text: "followUpNeutral", vars: {}, escalate: false };
  return { text: "followUpNegative", vars: {}, escalate: first };
}

// ── Métricas ────────────────────────────────────────────────────────────────

export interface FollowUpStats {
  sent: number;
  answered: number;
  positive: number;
  neutral: number;
  negative: number;
  reviewsRequested: number;
}

/** Seguimientos enviados en un rango y cómo respondieron (métricas del agente). */
export async function followUpStats(db: Executor, businessId: string, range: { from: Date; to: Date }): Promise<FollowUpStats> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({
        sent: sql<number>`count(*)::int`,
        answered: sql<number>`(count(*) FILTER (WHERE ${followUps.sentiment} IS NOT NULL))::int`,
        positive: sql<number>`(count(*) FILTER (WHERE ${followUps.sentiment} = 'positive'))::int`,
        neutral: sql<number>`(count(*) FILTER (WHERE ${followUps.sentiment} = 'neutral'))::int`,
        negative: sql<number>`(count(*) FILTER (WHERE ${followUps.sentiment} = 'negative'))::int`,
        reviewsRequested: sql<number>`(count(*) FILTER (WHERE ${followUps.reviewRequested}))::int`,
      })
      .from(followUps)
      .where(and(eq(followUps.businessId, businessId), gte(followUps.sentAt, range.from), lt(followUps.sentAt, range.to))),
  );
  return {
    sent: Number(row?.sent ?? 0),
    answered: Number(row?.answered ?? 0),
    positive: Number(row?.positive ?? 0),
    neutral: Number(row?.neutral ?? 0),
    negative: Number(row?.negative ?? 0),
    reviewsRequested: Number(row?.reviewsRequested ?? 0),
  };
}
