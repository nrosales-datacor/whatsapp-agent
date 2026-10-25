import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { isTransientError } from "../../platform/net/transient";
import { marketingRecipient } from "../clients";
import { channelForLocation, credentialsOf, listChannelRows } from "./channels";
import { ensureConversation, saveOutgoingMessage } from "./conversations";
import type { WhatsAppDeps } from "./deps";
import { GraphError } from "./graph";
import { conversations, messages } from "./schema";
import { incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Promociones por WhatsApp (I6): lo que Campañas usa para mandar, sin conocer Graph ni las
// tablas de este módulo.
//
//   • `sendMarketingTemplate`: re-chequea que el cliente HOY pueda recibir promociones
//     (consentimiento, sin baja, con teléfono; clients), elige el número de su sucursal
//     preferida (o el general) y manda la plantilla de MARKETING aprobada de ese número con
//     {{1}} nombre del cliente · {{2}} el mensaje de la campaña. Fuera de la ventana de
//     24 h solo se puede con plantilla, y una promoción siempre es categoría marketing
//     para Meta: nunca va como texto libre.
//   • `countRepliesAfterSends`: cuántos clientes escribieron después de recibirla.
//   • `marketingChannelStatus`: si hay número conectado y con plantilla (lo avisa el panel).
// ─────────────────────────────────────────────────────────────────────────────

export type MarketingSendOutcome =
  | { status: "sent" }
  /** Ya no puede recibir promociones (baja, sin consentimiento, sin teléfono o datos eliminados). */
  | { status: "skipped"; reason: "not_reachable" }
  | { status: "failed"; reason: "no_channel" | "no_template" | "token_invalid" | "send_failed"; transient: boolean };

export interface MarketingSendInput {
  clientId: string;
  /** Texto de la campaña ({{2}} de la plantilla). */
  message: string;
  /** Nombre de la campaña (solo para la constancia en el historial). */
  campaignName: string;
}

/** Manda una promoción a un cliente con la plantilla de marketing de su número. Nunca lanza. */
export async function sendMarketingTemplate(
  db: Executor,
  deps: Pick<WhatsAppDeps, "api" | "now">,
  businessId: string,
  input: MarketingSendInput,
): Promise<MarketingSendOutcome> {
  const recipient = await marketingRecipient(db, businessId, input.clientId);
  if (!recipient) return { status: "skipped", reason: "not_reachable" };
  const channel = await channelForLocation(db, businessId, recipient.preferredLocationId);
  const credentials = channel ? credentialsOf(channel) : null;
  if (!channel || !credentials) return { status: "failed", reason: "no_channel", transient: false };
  const template = channel.templates?.marketing;
  if (!template) return { status: "failed", reason: "no_template", transient: false };

  try {
    await deps.api.sendTemplate(credentials, recipient.phone, {
      name: template.name,
      language: template.language,
      bodyParams: [recipient.name, input.message],
    });
  } catch (e) {
    if (e instanceof GraphError && e.tokenInvalid) return { status: "failed", reason: "token_invalid", transient: false };
    return { status: "failed", reason: "send_failed", transient: isTransientError(e) };
  }
  // Constancia en la conversación (el operador ve qué le llegó). Si esto falla, el envío
  // igual salió: no se reporta como falla (un reintento lo duplicaría).
  const now = deps.now();
  try {
    const conversation = await ensureConversation(db, businessId, channel.id, recipient.id);
    await saveOutgoingMessage(db, businessId, conversation.id, { content: `📣 Campaña «${input.campaignName}»: ${input.message}`, at: now });
    await incrementAiUsage(db, businessId, { messagesOut: 1, marketingTemplates: 1 }, now);
  } catch {
    // best-effort
  }
  return { status: "sent" };
}

/**
 * Clientes distintos que escribieron por WhatsApp después de recibir su envío (hasta
 * `withinDays` días). `sends` es una subconsulta con columnas `client_id` y `sent_at` (la
 * arma Campañas sobre sus envíos).
 */
export async function countRepliesAfterSends(executor: Executor, businessId: string, sends: SQL, withinDays = 7): Promise<number> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.execute(sql`
      SELECT count(DISTINCT s.client_id)::int AS replied
        FROM (${sends}) s
       WHERE EXISTS (
         SELECT 1 FROM ${conversations} c
           JOIN ${messages} m ON m.conversation_id = c.id
          WHERE c.business_id = ${businessId} AND c.client_id = s.client_id
            AND m.role = 'user' AND m.created_at > s.sent_at
            AND m.created_at <= s.sent_at + make_interval(days => ${withinDays}))`),
  );
  return Number(rowsOf<{ replied: number | string }>(rows)[0]?.replied ?? 0);
}

export interface MarketingChannelStatus {
  /** Números activos con token. */
  connected: number;
  /** De esos, cuántos tienen la plantilla de marketing cargada. */
  withTemplate: number;
}

/** ¿Se pueden mandar promociones? (número conectado y con plantilla de marketing). */
export async function marketingChannelStatus(db: Executor, businessId: string): Promise<MarketingChannelStatus> {
  const active = (await listChannelRows(db, businessId)).filter((r) => r.status === "active" && r.accessTokenEncrypted);
  return { connected: active.length, withTemplate: active.filter((r) => r.templates?.marketing).length };
}
