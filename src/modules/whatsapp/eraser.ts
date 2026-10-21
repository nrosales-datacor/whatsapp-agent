import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { log } from "../../platform/observability/log";
import { enqueue, PermanentJobError, type JobContext } from "../../platform/queue";
import type { ClientDataEraser } from "../clients";
import type { WhatsAppDeps } from "./deps";
import { conversations, messages } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Derecho de supresión (Ley 8968): lo que el módulo WhatsApp guarda de un cliente. Lo
// llama la anonimización del cliente (clients) DENTRO de su transacción: se borran sus
// conversaciones (y con ellas, en cascada, sus mensajes), y los adjuntos en Storage se
// borran por la cola (`whatsapp.media.erase`, encolado en la MISMA transacción: si la
// anonimización hace rollback, no se borra nada). Devuelve conteos para el rastro de
// auditoría, nunca datos personales.
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_MEDIA_ERASE_JOB = "whatsapp.media.erase";

export interface MediaErasePayload {
  paths: string[];
}

export const whatsappClientEraser: ClientDataEraser = async (tx, { businessId, clientId }) => {
  const convs = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.clientId, clientId)));
  if (convs.length === 0) return { whatsappConversations: 0, whatsappMessages: 0, whatsappMedia: 0 };
  const ids = convs.map((c) => c.id);
  const [total] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.businessId, businessId), inArray(messages.conversationId, ids)));
  const media = await tx
    .select({ path: messages.mediaPath })
    .from(messages)
    .where(and(eq(messages.businessId, businessId), inArray(messages.conversationId, ids), isNotNull(messages.mediaPath)));
  const paths = media.map((m) => m.path).filter((p): p is string => Boolean(p));
  await tx.delete(conversations).where(and(eq(conversations.businessId, businessId), inArray(conversations.id, ids)));
  // Lotes de 200 rutas por job (rutas de Storage: sin datos personales).
  for (let i = 0; i < paths.length; i += 200) {
    await enqueue<MediaErasePayload>(tx, { type: WHATSAPP_MEDIA_ERASE_JOB, businessId, payload: { paths: paths.slice(i, i + 200) } });
  }
  return { whatsappConversations: ids.length, whatsappMessages: Number(total?.n ?? 0), whatsappMedia: paths.length };
};

/** Borra de Storage los adjuntos de un cliente suprimido (solo rutas del propio negocio). */
export async function handleMediaEraseJob(rawPayload: unknown, ctx: JobContext, deps: Pick<WhatsAppDeps, "storage">): Promise<number> {
  const paths = (rawPayload as Partial<MediaErasePayload> | null)?.paths;
  if (!ctx.businessId || !Array.isArray(paths)) throw new PermanentJobError("whatsapp.media.erase: payload inválido");
  const own = paths.filter((p): p is string => typeof p === "string" && p.startsWith(`${ctx.businessId}/`));
  if (own.length === 0 || !deps.storage.configured()) return 0;
  const deleted = await deps.storage.remove(own);
  log.info("whatsapp_media_erased", { businessId: ctx.businessId, deleted });
  return deleted;
}
