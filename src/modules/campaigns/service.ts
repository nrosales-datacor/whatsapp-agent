import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { isTenantId, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { enqueue } from "../../platform/queue";
import { getBusinessContext } from "../business";
import { getClientsByIds, listMarketingAudienceIds, marketingConsentSummary, previewMarketingAudience, type MarketingAudience } from "../clients";
import { countAppointmentsAfterSends } from "../scheduling";
import { countRepliesAfterSends, marketingChannelStatus, type MarketingChannelStatus } from "../whatsapp";
import { campaigns, campaignSends, type Campaign, type CampaignSegment, type CampaignSendStatus, type CampaignStatus } from "./schema";
import { CampaignSegmentInput, segmentQuery } from "./segment";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas (I6.1, PLAN-GESTION.md §11; portado de legacy/src/campaigns): una promoción
// por WhatsApp a un segmento de clientes que aceptaron recibirlas.
//
//   borrador → (programada) → enviando → completada | cancelada
//
//   • Borrador: nombre, mensaje (la variable {{2}} de la plantilla de marketing) y segmento.
//     Se edita y se previsualiza (cuántos la reciben y cuántos quedan afuera, y por qué).
//   • Lanzar: en UNA transacción se arma la lista (snapshot en `campaign_sends`, solo
//     quienes HOY pueden recibir promociones), la campaña pasa a programada o enviando y se
//     encola su despacho (outbox). Sin destinatarios o sin plantilla de marketing: 409.
//   • Despacho (./dispatch.ts): por la cola genérica, de a lotes con pausa entre envíos.
//     Cada envío vuelve a chequear el consentimiento (alguien pudo pedir la baja).
//   • Cancelar: lo pendiente queda `skipped` y el despacho se detiene solo.
//   • Resultados: enviados, fallidos, omitidos, cuántos respondieron por WhatsApp y cuántas
//     citas se agendaron después (hasta 30 días).
//
// Todo queda en el rastro de auditoría (lanzar y cancelar), sin datos personales.
// ─────────────────────────────────────────────────────────────────────────────

export const CAMPAIGN_DISPATCH_JOB = "campaign.dispatch";

/** Lo que se guarda en el job de despacho (solo ids). */
export interface CampaignDispatchPayload {
  campaignId: string;
}

const MAX_MESSAGE = 900;

/** Texto de la campaña: va en una variable de la plantilla, que Meta no acepta con saltos de línea ni tabs. */
const Message = z
  .string()
  .trim()
  .min(1, "Escribí el mensaje.")
  .max(MAX_MESSAGE, `Hasta ${MAX_MESSAGE} caracteres.`)
  .refine((m) => !/[\n\r\t]/.test(m), "El mensaje va en un solo párrafo: WhatsApp no permite saltos de línea en la variable de la plantilla.")
  .refine((m) => !/ {5,}/.test(m), "Sacá los espacios seguidos: WhatsApp no los permite en la plantilla.");

export const CampaignInput = z
  .object({
    name: z.string().trim().min(1, "Poné un nombre.").max(80),
    message: Message,
    segment: CampaignSegmentInput,
  })
  .strict();

export const CampaignPatch = CampaignInput.partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export const LaunchInput = z
  .object({
    /** Cuándo mandarla (ISO); null o ausente = ya. */
    scheduledFor: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type CampaignInputValue = z.output<typeof CampaignInput>;
export type CampaignPatchValue = z.output<typeof CampaignPatch>;

/** Conteos de envíos por estado. */
export interface SendCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  message: string;
  segment: CampaignSegment;
  status: CampaignStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  totalRecipients: number;
  counts: SendCounts;
}

export interface CampaignDetail extends CampaignSummary {
  results: {
    /** Clientes que escribieron por WhatsApp en los 7 días siguientes a su envío. */
    replied: number;
    /** Citas creadas en los 30 días siguientes al envío (sin las canceladas). */
    appointments: number;
    /** Clientes distintos que agendaron. */
    clientsBooked: number;
  };
  /** Los primeros destinatarios, con su estado (la lista completa puede ser larga). */
  recipients: { clientId: string; name: string; status: CampaignSendStatus; error: string | null; sentAt: string | null }[];
}

export interface CampaignsOverview {
  consent: { clients: number; consented: number; optedOut: number };
  channels: MarketingChannelStatus;
}

const RECIPIENTS_SHOWN = 200;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const notFound = () => new HttpError(404, "Esa campaña no existe.", "not_found");

function emptyCounts(): SendCounts {
  return { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
}

function toSummary(row: Campaign, counts: SendCounts): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    segment: row.segment ?? {},
    status: row.status as CampaignStatus,
    scheduledFor: iso(row.scheduledFor),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    totalRecipients: row.totalRecipients,
    counts,
  };
}

async function countsFor(executor: Executor, businessId: string, ids: string[]): Promise<Map<string, SendCounts>> {
  const out = new Map<string, SendCounts>();
  if (ids.length === 0) return out;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ campaignId: campaignSends.campaignId, status: campaignSends.status, n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(and(eq(campaignSends.businessId, businessId), inArray(campaignSends.campaignId, ids)))
      .groupBy(campaignSends.campaignId, campaignSends.status),
  );
  for (const r of rows) {
    const c = out.get(r.campaignId) ?? emptyCounts();
    const n = Number(r.n);
    c.total += n;
    // `processing` cuenta como pendiente (se está mandando).
    if (r.status === "sent") c.sent += n;
    else if (r.status === "failed") c.failed += n;
    else if (r.status === "skipped") c.skipped += n;
    else c.pending += n;
    out.set(r.campaignId, c);
  }
  return out;
}

async function getRow(executor: Executor, businessId: string, id: string): Promise<Campaign | null> {
  if (!isTenantId(id)) return null;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, id)))
      .limit(1),
  );
  return row ?? null;
}

/** Campañas del negocio, las más nuevas primero. */
export async function listCampaigns(executor: Executor, businessId: string): Promise<CampaignSummary[]> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.select().from(campaigns).where(eq(campaigns.businessId, businessId)).orderBy(desc(campaigns.createdAt)).limit(200),
  );
  const counts = await countsFor(executor, businessId, rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, counts.get(r.id) ?? emptyCounts()));
}

/** Consentimiento de la cartera y estado de los números (el encabezado de Campañas). */
export async function campaignsOverview(executor: Executor, businessId: string): Promise<CampaignsOverview> {
  const [consent, channels] = await Promise.all([marketingConsentSummary(executor, businessId), marketingChannelStatus(executor, businessId)]);
  return { consent, channels };
}

async function timeZoneOf(executor: Executor, businessId: string): Promise<string> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx.business.timezone;
}

/** Quiénes recibirían una campaña con este segmento si se mandara ahora. */
export async function previewSegment(executor: Executor, businessId: string, segment: CampaignSegment, now: Date = new Date()): Promise<MarketingAudience & { channels: MarketingChannelStatus }> {
  const { filters, scope } = segmentQuery(businessId, segment, now, await timeZoneOf(executor, businessId));
  const [audience, channels] = await Promise.all([
    previewMarketingAudience(executor, businessId, filters, { scope, now }),
    marketingChannelStatus(executor, businessId),
  ]);
  return { ...audience, channels };
}

export async function getCampaign(executor: Executor, businessId: string, id: string): Promise<CampaignDetail> {
  const row = await getRow(executor, businessId, id);
  if (!row) throw notFound();
  const counts = (await countsFor(executor, businessId, [row.id])).get(row.id) ?? emptyCounts();
  const sends = sql`SELECT ${campaignSends.clientId} AS client_id, ${campaignSends.sentAt} AS sent_at FROM ${campaignSends}
    WHERE ${campaignSends.businessId} = ${businessId} AND ${campaignSends.campaignId} = ${row.id} AND ${campaignSends.status} = 'sent'`;
  const [replied, booked, shown] = await Promise.all([
    counts.sent > 0 ? countRepliesAfterSends(executor, businessId, sends) : Promise.resolve(0),
    counts.sent > 0 ? countAppointmentsAfterSends(executor, businessId, sends) : Promise.resolve({ appointments: 0, clients: 0 }),
    withTenant(executor, businessId, (tx) =>
      tx
        .select()
        .from(campaignSends)
        .where(and(eq(campaignSends.businessId, businessId), eq(campaignSends.campaignId, row.id)))
        .orderBy(asc(campaignSends.createdAt), asc(campaignSends.id))
        .limit(RECIPIENTS_SHOWN),
    ),
  ]);
  const names = new Map((await getClientsByIds(executor, businessId, shown.map((s) => s.clientId))).map((c) => [c.id, c.name]));
  return {
    ...toSummary(row, counts),
    results: { replied, appointments: booked.appointments, clientsBooked: booked.clients },
    recipients: shown.map((s) => ({
      clientId: s.clientId,
      name: names.get(s.clientId) ?? "",
      status: s.status as CampaignSendStatus,
      error: s.error,
      sentAt: iso(s.sentAt),
    })),
  };
}

export async function createCampaign(executor: Executor, businessId: string, input: CampaignInputValue, userId: string | null): Promise<CampaignDetail> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .insert(campaigns)
      .values({ businessId, name: input.name, message: input.message, segment: input.segment, createdBy: userId })
      .returning(),
  );
  return getCampaign(executor, businessId, row.id);
}

/** Bloquea la campaña y exige que siga en borrador. */
async function lockDraft(tx: Tx, businessId: string, id: string): Promise<Campaign> {
  if (!isTenantId(id)) throw notFound();
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, id)))
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  if (row.status !== "draft") throw new HttpError(409, "La campaña ya se lanzó: no se puede cambiar.", "campaign_not_draft");
  return row;
}

export async function updateCampaign(executor: Executor, businessId: string, id: string, patch: CampaignPatchValue): Promise<CampaignDetail> {
  await withTenant(executor, businessId, async (tx) => {
    await lockDraft(tx, businessId, id);
    await tx.update(campaigns).set(patch).where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, id)));
  });
  return getCampaign(executor, businessId, id);
}

export async function deleteCampaign(executor: Executor, businessId: string, id: string): Promise<void> {
  await withTenant(executor, businessId, async (tx) => {
    await lockDraft(tx, businessId, id);
    await tx.delete(campaigns).where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, id)));
  });
}

/** Filas por INSERT al materializar la lista (lejos del tope de parámetros de Postgres). */
const INSERT_CHUNK = 1000;

/**
 * Lanza una campaña en borrador: arma la lista con quienes HOY pueden recibir promociones,
 * la deja programada (si `scheduledFor` es futuro) o enviando, y encola el despacho. Todo
 * en la misma transacción: o queda lanzada con su lista y su job, o nada.
 */
export async function launchCampaign(
  executor: Executor,
  businessId: string,
  id: string,
  input: { scheduledFor?: Date | null; userId: string; now?: Date },
): Promise<CampaignDetail> {
  const now = input.now ?? new Date();
  const scheduled = input.scheduledFor && input.scheduledFor.getTime() > now.getTime() ? input.scheduledFor : null;
  if (scheduled && scheduled.getTime() > now.getTime() + 90 * 86_400_000) {
    throw new HttpError(400, "Se puede programar hasta 90 días adelante.", "invalid_schedule");
  }
  const timeZone = await timeZoneOf(executor, businessId);
  const channels = await marketingChannelStatus(executor, businessId);
  if (channels.withTemplate === 0) {
    throw new HttpError(
      409,
      channels.connected === 0
        ? "Conectá un número de WhatsApp para mandar campañas."
        : "Cargá la plantilla de marketing aprobada por Meta en WhatsApp IA › Configuración › Números.",
      "no_marketing_template",
    );
  }
  await withTenant(executor, businessId, async (tx) => {
    const row = await lockDraft(tx, businessId, id);
    const { filters, scope } = segmentQuery(businessId, row.segment ?? {}, now, timeZone);
    const ids = await listMarketingAudienceIds(tx, businessId, filters, { scope, now });
    if (ids.length === 0) {
      throw new HttpError(409, "Nadie de ese segmento aceptó recibir promociones todavía: no hay a quién mandarle.", "empty_audience");
    }
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      await tx
        .insert(campaignSends)
        .values(ids.slice(i, i + INSERT_CHUNK).map((clientId) => ({ businessId, campaignId: row.id, clientId })))
        .onConflictDoNothing();
    }
    await tx
      .update(campaigns)
      .set({
        status: scheduled ? "scheduled" : "sending",
        scheduledFor: scheduled,
        startedAt: scheduled ? null : now,
        totalRecipients: ids.length,
      })
      .where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, row.id)));
    await enqueue<CampaignDispatchPayload>(tx, {
      type: CAMPAIGN_DISPATCH_JOB,
      businessId,
      payload: { campaignId: row.id },
      runAfter: scheduled ?? undefined,
      dedupeKey: `campaign:${row.id}:start`,
      groupKey: `campaign:${row.id}`,
    });
    await recordAudit(tx, businessId, "campaign_launched", userActor(input.userId), {
      campaignId: row.id,
      recipients: ids.length,
      scheduledFor: scheduled ? scheduled.toISOString() : null,
    });
  });
  return getCampaign(executor, businessId, id);
}

/** Cancela una campaña que no terminó: lo pendiente queda omitido y el despacho se detiene. */
export async function cancelCampaign(executor: Executor, businessId: string, id: string, userId: string): Promise<CampaignDetail> {
  if (!isTenantId(id)) throw notFound();
  await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.businessId, businessId), eq(campaigns.id, id)))
      .limit(1)
      .for("update");
    if (!row) throw notFound();
    if (row.status === "completed" || row.status === "cancelled") {
      throw new HttpError(409, row.status === "completed" ? "La campaña ya terminó." : "La campaña ya estaba cancelada.", "campaign_finished");
    }
    await tx.update(campaigns).set({ status: "cancelled", completedAt: new Date() }).where(eq(campaigns.id, row.id));
    await tx
      .update(campaignSends)
      .set({ status: "skipped", error: "cancelled" })
      .where(and(eq(campaignSends.campaignId, row.id), eq(campaignSends.status, "pending")));
    await recordAudit(tx, businessId, "campaign_cancelled", userActor(userId), { campaignId: row.id, previousStatus: row.status });
  });
  return getCampaign(executor, businessId, id);
}
