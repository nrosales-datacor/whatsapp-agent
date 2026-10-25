import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses } from "../business/schema";
import { clients } from "../clients/schema";
import { users } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo campaigns: envío de una plantilla de marketing a un segmento de clientes
// (PLAN-GESTION.md §4). Lo del esquema viejo, con `client_id` en vez del teléfono. Solo
// va a clientes con consentimiento de marketing y sin baja (`clients`): eso se filtra al
// materializar los envíos y se re-chequea al enviar.
// ─────────────────────────────────────────────────────────────────────────────

/** draft → (scheduled) → sending → completed | cancelled */
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** pending → processing → sent | failed (reintenta si quedan intentos) | skipped (baja o sin consentimiento) */
export const CAMPAIGN_SEND_STATUSES = ["pending", "processing", "sent", "failed", "skipped"] as const;
export type CampaignSendStatus = (typeof CAMPAIGN_SEND_STATUSES)[number];

/**
 * Cómo se arma la lista de destinatarios (I6): los filtros de la lista de clientes del CRM
 * más dos propios de las campañas. Todo combinado con Y; vacío = todos los que aceptaron
 * promociones. Las fechas son RELATIVAS a cuando se arma el envío (una campaña programada
 * para el mes que viene usa "hace 60 días" de ese día).
 */
export interface CampaignSegment {
  statuses?: string[];
  tags?: string[];
  vip?: boolean;
  preferredLocationId?: string;
  preferredStaffId?: string;
  /** Última visita hace AL MENOS estos días. */
  lastVisitMinDays?: number;
  /** Última visita hace COMO MUCHO estos días. */
  lastVisitMaxDays?: number;
  /** "Te toca de nuevo": su último `serviceId` completado fue hace al menos `months` meses. */
  lapsedService?: { serviceId: string; months: number };
  /** Sin quien ya tiene una cita próxima (default true: ya vuelve solo). */
  excludeUpcoming?: boolean;
}

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuidPk(),
    businessId: businessId(),
    name: text("name").notNull(),
    // Texto que llena la variable libre de la plantilla (igual para todos los destinatarios).
    message: text("message").notNull(),
    segment: jsonb("segment").$type<CampaignSegment>().notNull(),
    status: text("status").notNull().default("draft"),
    scheduledFor: instant("scheduled_for"),
    startedAt: instant("started_at"),
    completedAt: instant("completed_at"),
    totalRecipients: integer("total_recipients").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("campaigns_business_created_idx").on(t.businessId, t.createdAt),
    check("campaigns_status_check", oneOf(t.status, CAMPAIGN_STATUSES)),
    tenantPolicy(),
  ],
).enableRLS();

export const campaignSends = pgTable(
  "campaign_sends",
  {
    id: uuidPk(),
    businessId: businessId(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    sentAt: instant("sent_at"),
    ...timestamps(),
  },
  (t) => [
    // Idempotencia: el segmento no inserta dos veces al mismo cliente en la misma campaña.
    uniqueIndex("campaign_sends_campaign_client_uq").on(t.campaignId, t.clientId),
    // Progreso de una campaña y claim de los pendientes.
    index("campaign_sends_campaign_status_idx").on(t.campaignId, t.status),
    index("campaign_sends_client_idx").on(t.clientId),
    check("campaign_sends_status_check", oneOf(t.status, CAMPAIGN_SEND_STATUSES)),
    tenantPolicy(),
  ],
).enableRLS();

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignSend = typeof campaignSends.$inferSelect;
export type NewCampaignSend = typeof campaignSends.$inferInsert;
