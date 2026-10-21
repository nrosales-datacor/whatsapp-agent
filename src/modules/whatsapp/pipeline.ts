import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { isTransientError } from "../../platform/net/transient";
import { alertPlatform } from "../../platform/observability/alerts";
import { incrementDailyUsage } from "../../platform/observability/dailyUsage";
import { log } from "../../platform/observability/log";
import { hasNewerGroupJob, PermanentJobError, type JobContext } from "../../platform/queue";
import { getBusinessContext } from "../business";
import { getClient, recordMarketingOptOut, type ClientView } from "../clients";
import {
  cancelAppointment,
  confirmAppointment,
  getAppointment,
  listUpcomingAppointmentsForClient,
  localDate,
} from "../scheduling";
import type { AgentHistoryMessage, AgentReply, AgentTurnResult } from "./agentContract";
import { credentialsOf, getChannelRow } from "./channels";
import { appointmentReplyOf, requestsHuman } from "./commands";
import {
  botActivitySince,
  currentMode,
  getConversation,
  getMessage,
  historyUpTo,
  lastHumanReplyAt,
  markBotNoticeSent,
  recentInbound,
  saveOutgoingMessage,
  setConversationMode,
  updateMessage,
} from "./conversations";
import { loadTextProfile, notifyTeam, type WhatsAppDeps } from "./deps";
import type { ChannelCredentials, ReplyButton } from "./graph";
import type { InboundJobPayload } from "./ingest";
import { capStatus, CLIENT_LIMIT_NOTICE_PREFIX, clientTurnsPerHour, detectLoop, loopRepeats, loopWindowMin } from "./limits";
import { mediaObjectPath } from "./media";
import { humanModeExpired } from "./rules";
import type { Conversation, Message } from "./schema";
import { pipelineText, type PipelineTextKey, type TextProfile } from "./texts";
import { getAiUsage, incrementAiUsage, whisperCostMicros } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Handler del job `whatsapp.inbound` (fase 2: después del 200 a Meta). Portado de
// legacy/src/handleWebhook.ts (`responderEntrante`) sobre el esquema nuevo y el contrato
// con el agente (./agentContract.ts). Por cada mensaje entrante, en orden:
//
//   1. Ráfaga: un texto común cede si hay un turno más nuevo de la misma conversación que
//      va a releer el historial (lo responde ese).
//   2. Foto o audio: se descarga de Graph y se guarda en Storage (el operador la ve en la
//      bandeja tanto si atiende el bot como una persona).
//   3. Acciones directas, sin agente y en cualquier modo: "Confirmo"/"Cancelar" del
//      recordatorio (sobre scheduling) y BAJA de promociones (sobre clients).
//   4. Modo humano: si venció (nadie del equipo actuó en N horas) vuelve al bot; si no, el
//      bot NO responde y se avisa al equipo por push.
//   5. Pedido explícito de una persona → modo humano + aviso.
//   6. Adjuntos que el bot no lee (documento, contacto, sticker) → texto fijo + aviso.
//   7. Frenos por cliente (bucle con otro bot, turnos por hora) y topes mensuales del plan
//      (conversaciones, gasto de LLM): sin llamar al LLM.
//   8. Audio → transcripción (Whisper). 9. Agente con el historial hasta este mensaje.
//   10. Si mientras pensaba una persona tomó la conversación, se descarta la respuesta.
//   11. Acciones (`handoff` → modo humano + push), envío de respuestas (texto o botones),
//       salientes guardados, aviso de bot la primera vez y uso del mes.
//
// Reintentos: un error transitorio (Graph caído, OpenAI 429/5xx) relanza para que la cola
// reintente el turno ENTERO con backoff, mientras queden intentos y el turno no haya
// dejado efectos que un reintento duplicaría (una respuesta enviada, una cita agendada).
// En el último intento se le pide disculpas al cliente y se avisa al equipo.
// ─────────────────────────────────────────────────────────────────────────────

/** Mensajes del historial que recibe el agente. */
const HISTORY_LIMIT = () => positiveInt(process.env.WHATSAPP_AGENT_HISTORY_MESSAGES, 30);
/** Antigüedad máxima del historial (días). */
const HISTORY_MAX_DAYS = () => positiveInt(process.env.WHATSAPP_AGENT_HISTORY_DAYS, 30);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const KINDS = new Set(["text", "image", "audio", "document", "contact", "unsupported"]);
const ACTIONS = new Set(["appointment_reply", "opt_out", "human_request"]);

function parsePayload(raw: unknown): InboundJobPayload {
  const p = raw as Partial<InboundJobPayload> | null;
  if (!p || typeof p.messageId !== "string" || typeof p.conversationId !== "string" || !KINDS.has(String(p.kind))) {
    throw new PermanentJobError("whatsapp.inbound: payload inválido");
  }
  if (p.action !== null && p.action !== undefined && !ACTIONS.has(p.action)) throw new PermanentJobError("whatsapp.inbound: acción inválida");
  return { ...p, action: p.action ?? null, groupable: p.groupable === true, rereadsHistory: p.rereadsHistory === true } as InboundJobPayload;
}

/** Lo que el turno sabe del mensaje y su contexto. */
interface Turn {
  db: Executor;
  deps: WhatsAppDeps;
  ctx: JobContext;
  businessId: string;
  payload: InboundJobPayload;
  conversation: Conversation;
  message: Message;
  client: ClientView;
  clientPhone: string;
  credentials: ChannelCredentials;
  locationId: string | null;
  texts: TextProfile;
  timeZone: string;
  now: Date;
  /** Algo ya le llegó al cliente o cambió datos: un reintento lo duplicaría. */
  effects: boolean;
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** ¿Relanzar para que la cola reintente? Solo si es transitorio, sin efectos y con intentos. */
function shouldRetry(turn: Pick<Turn, "ctx" | "effects">, e: unknown): boolean {
  return !turn.effects && !turn.ctx.isLastAttempt && isTransientError(e);
}

// ── Salida al cliente ────────────────────────────────────────────────────────

/**
 * Manda un texto (o texto con botones) al cliente y lo guarda. Envía PRIMERO y guarda
 * DESPUÉS: si el envío falla no queda en el historial algo que el cliente no recibió. El
 * primer mensaje automático de la conversación lleva el aviso de que atiende un bot.
 */
async function sendToClient(turn: Turn, reply: AgentReply): Promise<void> {
  const notice = turn.conversation.botNoticeSentAt ? null : pipelineText(turn.texts, "botNotice");
  const body = notice ? `${notice}\n\n${reply.text}` : reply.text;
  const buttons: ReplyButton[] = (reply.buttons ?? []).slice(0, 3).filter((b) => b.id && b.title);
  if (buttons.length > 0) await turn.deps.api.sendButtons(turn.credentials, turn.clientPhone, body, buttons);
  else await turn.deps.api.sendText(turn.credentials, turn.clientPhone, body);
  turn.effects = true;
  const now = turn.deps.now();
  const content = buttons.length > 0 ? `${body}\n[${buttons.map((b) => b.title).join(" / ")}]` : body;
  await saveOutgoingMessage(turn.db, turn.businessId, turn.conversation.id, { content, at: now });
  await incrementAiUsage(turn.db, turn.businessId, { messagesOut: 1 }, now);
  if (notice) {
    await markBotNoticeSent(turn.db, turn.businessId, turn.conversation.id, now);
    turn.conversation = { ...turn.conversation, botNoticeSentAt: now };
  }
}

/** Texto fijo del pipeline; si no se puede mandar, se registra y sigue (nunca tumba el turno). */
async function sendFixed(turn: Turn, key: PipelineTextKey, vars: Record<string, string> = {}): Promise<boolean> {
  try {
    await sendToClient(turn, { text: pipelineText(turn.texts, key, vars) });
    return true;
  } catch (e) {
    log.warn("whatsapp_fixed_text_failed", { businessId: turn.businessId, conversationId: turn.conversation.id, key, error: short(e) });
    return false;
  }
}

async function notify(turn: Turn, body: string): Promise<void> {
  await notifyTeam(turn.db, turn.deps, turn.businessId, { id: turn.conversation.id, clientName: turn.client.name }, body);
}

/** Pasa la conversación a una persona (modo humano) y lo cuenta para las métricas. */
async function handOff(turn: Turn, countAsHandoff = true): Promise<void> {
  await setConversationMode(turn.db, turn.businessId, turn.conversation.id, "human", turn.deps.now());
  turn.conversation = { ...turn.conversation, mode: "human", humanSince: turn.deps.now() };
  if (countAsHandoff) {
    await incrementDailyUsage(turn.db, turn.businessId, { date: localDate(turn.now, turn.timeZone), metric: "whatsapp_handoffs" }).catch((e) =>
      log.warn("whatsapp_handoff_metric_failed", { businessId: turn.businessId, error: short(e) }),
    );
  }
}

// ── Acciones directas ────────────────────────────────────────────────────────

async function handleAppointmentReply(turn: Turn): Promise<void> {
  const reply = appointmentReplyOf({ interactiveId: turn.payload.interactiveId, buttonText: turn.payload.buttonText });
  if (!reply) return;
  let appointmentId = reply.appointmentId;
  if (!appointmentId) {
    // Botón de una plantilla sin nuestro payload: la próxima cita del cliente.
    appointmentId = (await listUpcomingAppointmentsForClient(turn.db, turn.businessId, turn.client.id, { now: turn.now, limit: 1 }))[0]?.id ?? null;
  }
  const appointment = appointmentId ? await getAppointment(turn.db, turn.businessId, appointmentId) : null;
  const usable =
    appointment &&
    appointment.clientId === turn.client.id &&
    (appointment.status === "pending" || appointment.status === "confirmed") &&
    Date.parse(appointment.startsAt) > turn.now.getTime();
  if (!appointment || !usable) {
    await sendFixed(turn, "appointmentReplyUnavailable");
    return;
  }
  try {
    if (reply.action === "confirm") {
      if (appointment.status === "pending") await confirmAppointment(turn.db, turn.businessId, appointment.id, { now: turn.now });
    } else {
      await cancelAppointment(turn.db, turn.businessId, appointment.id, "Cancelada por el cliente desde WhatsApp", { now: turn.now });
    }
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    await sendFixed(turn, "appointmentReplyUnavailable");
    return;
  }
  turn.effects = true;
  log.info("whatsapp_appointment_reply", { businessId: turn.businessId, appointmentId: appointment.id, action: reply.action }); // log-pii-ok: action es el enum confirm | cancel
  await sendFixed(turn, reply.action === "confirm" ? "appointmentConfirmedAck" : "appointmentCancelledAck");
  if (reply.action === "cancel") await notify(turn, "❌ El cliente canceló su cita desde el recordatorio.");
}

async function handleOptOut(turn: Turn): Promise<void> {
  await recordMarketingOptOut(turn.db, turn.businessId, turn.client.id, turn.now);
  turn.effects = true;
  log.info("whatsapp_marketing_opt_out", { businessId: turn.businessId, conversationId: turn.conversation.id });
  await sendFixed(turn, "optOutAck");
}

async function handleHumanRequest(turn: Turn, operatorNote: string): Promise<void> {
  await handOff(turn);
  turn.effects = true;
  await sendFixed(turn, "humanRequested");
  await notify(turn, `🙋 Pidió hablar con una persona: ${operatorNote}`);
}

// ── Frenos ───────────────────────────────────────────────────────────────────

/** Bucle con otro bot o demasiados turnos por hora. true = no llamar al agente. Fail-open. */
async function applyClientBrakes(turn: Turn): Promise<boolean> {
  const limit = clientTurnsPerHour();
  const repeats = loopRepeats();
  if (limit === 0 && repeats === 0) return false;
  const nowMs = turn.now.getTime();
  let activity: { botTurns: number; noticeSent: boolean };
  let inbound: { content: string }[];
  try {
    activity = await botActivitySince(turn.db, turn.businessId, turn.conversation.id, new Date(nowMs - 3_600_000), CLIENT_LIMIT_NOTICE_PREFIX);
    inbound = await recentInbound(turn.db, turn.businessId, turn.conversation.id, new Date(nowMs - loopWindowMin() * 60_000));
  } catch (e) {
    log.warn("whatsapp_client_brakes_unreadable", { businessId: turn.businessId, error: short(e) });
    return false;
  }

  const loop = detectLoop(inbound, repeats);
  if (loop) {
    log.warn("whatsapp_bot_loop_detected", { businessId: turn.businessId, conversationId: turn.conversation.id, repeats: loop.repeats });
    await handOff(turn, false);
    // Al cliente NO se le manda nada: cualquier mensaje nuestro alimentaría el bucle.
    await notify(turn, `🔁 Posible bucle con otro bot (el mismo mensaje llegó ${loop.repeats} veces en ${loopWindowMin()} min). Pausamos el bot en esta conversación.`);
    return true;
  }

  if (limit === 0 || activity.botTurns < limit) return false;
  if (activity.noticeSent) return true;
  // Reclamo atómico del aviso (una vez por hora y conversación): el índice único del
  // `wa_message_id` sintético es el candado entre réplicas. Se guarda ANTES de mandarlo.
  const text = pipelineText(turn.texts, "clientRateLimited");
  const claimed = await saveOutgoingMessage(turn.db, turn.businessId, turn.conversation.id, {
    content: text,
    waMessageId: `${CLIENT_LIMIT_NOTICE_PREFIX}${turn.conversation.id}:${Math.floor(nowMs / 3_600_000)}`,
    at: turn.now,
  });
  if (!claimed) return true;
  log.warn("whatsapp_client_limit_reached", { businessId: turn.businessId, conversationId: turn.conversation.id, limit });
  await turn.deps.api.sendText(turn.credentials, turn.clientPhone, text).catch((e) =>
    log.warn("whatsapp_client_limit_notice_failed", { businessId: turn.businessId, error: short(e) }),
  );
  await notify(turn, `⏸️ Pasó el límite de ${limit} respuestas automáticas por hora: el bot no le contesta hasta que baje el ritmo.`);
  return true;
}

/** Topes mensuales del plan. true = no llamar al agente (ya se avisó y pasó a una persona). */
async function applyMonthlyCaps(turn: Turn): Promise<boolean> {
  const limits = await turn.deps.getAiLimits(turn.businessId);
  const usage = await getAiUsage(turn.db, turn.businessId, turn.now);
  const status = capStatus(limits, usage);
  if (!status.conversationsExceeded && !status.spendExceeded) return false;
  const reason = status.conversationsExceeded ? "conversaciones" : "gasto de IA";
  log.warn("whatsapp_monthly_cap_reached", { businessId: turn.businessId, cap: reason });
  alertPlatform({
    type: status.conversationsExceeded ? "whatsapp_conversation_cap" : "whatsapp_ai_spend_cap",
    tenantId: turn.businessId,
    severity: "warning",
    message: `El negocio llegó al tope mensual de ${reason}: el bot dejó de responder y pasa las conversaciones a una persona.`,
    cooldownMs: 24 * 60 * 60_000,
  });
  await handOff(turn);
  turn.effects = true;
  await sendFixed(turn, status.conversationsExceeded ? "conversationCapReached" : "spendCapReached");
  await notify(turn, `⚠️ El negocio llegó al tope mensual de ${reason}: el bot dejó de responder, atendé a mano.`);
  return true;
}

// ── Adjuntos ─────────────────────────────────────────────────────────────────

/** Descarga la foto o el audio y lo guarda en Storage. null si no se pudo bajar. */
async function fetchMedia(turn: Turn): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!turn.payload.mediaId) return null;
  let media: { buffer: Buffer; mimeType: string };
  try {
    media = await turn.deps.api.downloadMedia(turn.credentials, turn.payload.mediaId);
  } catch (e) {
    if (shouldRetry(turn, e)) throw e;
    log.warn("whatsapp_media_download_failed", { businessId: turn.businessId, conversationId: turn.conversation.id, error: short(e) });
    return null;
  }
  if (turn.deps.storage.configured() && !turn.message.mediaPath) {
    try {
      const path = mediaObjectPath(turn.businessId, turn.conversation.id, turn.message.waMessageId ?? turn.message.id, media.mimeType);
      await turn.deps.storage.upload(path, media.buffer, media.mimeType);
      await updateMessage(turn.db, turn.businessId, turn.message.id, { mediaPath: path });
      turn.message = { ...turn.message, mediaPath: path };
    } catch (e) {
      // Sin Storage la conversación sigue: el operador ve el marcador sin el adjunto.
      log.warn("whatsapp_media_upload_failed", { businessId: turn.businessId, error: short(e) });
    }
  }
  return media;
}

const HUMAN_MODE_NOTE: Record<string, string> = {
  image: "📷 Foto recibida.",
  audio: "🎤 Nota de voz recibida.",
  document: "📄 Llegó un documento.",
  contact: "👤 Compartió un contacto.",
  unsupported: "📎 Llegó un sticker o video.",
};

// ── Agente ───────────────────────────────────────────────────────────────────

function toHistory(rows: Message[]): AgentHistoryMessage[] {
  return rows.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: m.content, at: m.createdAt, ...(m.byHuman ? { byHuman: true } : {}) }));
}

async function runAgentTurn(turn: Turn, operatorNote: string): Promise<void> {
  let result: AgentTurnResult;
  try {
    const history = await historyUpTo(turn.db, turn.businessId, turn.message, { limit: HISTORY_LIMIT(), maxAgeDays: HISTORY_MAX_DAYS() });
    result = await turn.deps.agent(turn.db, {
      businessId: turn.businessId,
      conversationId: turn.conversation.id,
      clientId: turn.client.id,
      clientPhone: turn.clientPhone,
      clientName: turn.client.name,
      locationId: turn.locationId,
      history: toHistory(history),
      now: turn.now,
    });
  } catch (e) {
    if (shouldRetry(turn, e)) throw e;
    log.error("whatsapp_agent_failed", { businessId: turn.businessId, conversationId: turn.conversation.id, error: short(e) });
    await sendFixed(turn, "generalError");
    await notify(turn, `⚠️ El bot no pudo responder: ${operatorNote}`);
    return;
  }

  // Lo gastado se cuenta siempre (aunque la respuesta se descarte o falle el envío).
  await incrementAiUsage(
    turn.db,
    turn.businessId,
    { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, costMicros: result.usage?.costMicros },
    turn.now,
  );
  const actions = result.actions ?? [];
  if (actions.some((a) => a.type !== "handoff")) turn.effects = true; // una cita agendada/movida/cancelada no se repite
  for (const a of actions) {
    if (a.type !== "handoff") log.info("whatsapp_agent_action", { businessId: turn.businessId, action: a.type, appointmentId: a.appointmentId });
  }

  // Mientras el LLM pensaba, una persona pudo tomar la conversación desde la bandeja.
  if ((await currentMode(turn.db, turn.businessId, turn.conversation.id)) !== "bot") {
    log.info("whatsapp_reply_discarded", { businessId: turn.businessId, conversationId: turn.conversation.id, reason: "human_took_over" });
    return;
  }

  const handoff = actions.find((a): a is Extract<typeof a, { type: "handoff" }> => a.type === "handoff");
  if (handoff) await handOff(turn);

  const replies = (result.replies ?? []).filter((r) => r.text?.trim());
  if (replies.length === 0 && handoff) replies.push({ text: pipelineText(turn.texts, "botHandoff") });

  try {
    for (const reply of replies) await sendToClient(turn, reply);
  } catch (e) {
    if (shouldRetry(turn, e)) throw e;
    log.error("whatsapp_reply_send_failed", { businessId: turn.businessId, conversationId: turn.conversation.id, error: short(e) });
    await notify(turn, `⚠️ El bot no pudo enviar su respuesta: ${operatorNote}`);
    return;
  }
  if (handoff) await notify(turn, `🙋 El bot pasó este caso: ${handoff.reason}`);
  log.info("whatsapp_reply_sent", { businessId: turn.businessId, conversationId: turn.conversation.id, replies: replies.length, handoff: Boolean(handoff) });
}

// ── Entrada del job ──────────────────────────────────────────────────────────

/** Corre un `whatsapp.inbound`. Idempotente en lo que se puede (ver cabecera). */
export async function handleInboundJob(rawPayload: unknown, ctx: JobContext, deps: WhatsAppDeps): Promise<void> {
  const payload = parsePayload(rawPayload);
  const businessId = ctx.businessId;
  if (!businessId) throw new PermanentJobError("whatsapp.inbound: job sin negocio");
  const db = ctx.db;

  // 1. Ráfaga: un texto común cede ante un turno más nuevo que lo va a leer como contexto.
  if (payload.groupable && (await hasNewerGroupJob(db, { jobId: ctx.jobId, businessId, payloadFlag: "rereadsHistory", includeDone: ctx.attempt > 1 }))) {
    log.info("whatsapp_inbound_superseded", { businessId, conversationId: payload.conversationId, correlationId: payload.correlationId });
    return;
  }

  // Contexto vivo (el modo pudo cambiar mientras el job esperaba). Sin conversación (se
  // borraron los datos del cliente) no hay a quién responder.
  const conversation = await getConversation(db, businessId, payload.conversationId);
  const message = conversation ? await getMessage(db, businessId, payload.messageId) : null;
  if (!conversation || !message) return;
  const business = await getBusinessContext(db, businessId);
  if (!business || business.business.status !== "active") return;
  const client = await getClient(db, businessId, conversation.clientId);
  const channel = await getChannelRow(db, businessId, conversation.channelId);
  const credentials = channel ? credentialsOf(channel) : null;
  if (!client?.phone || !channel || !credentials) {
    log.warn("whatsapp_inbound_unanswerable", { businessId, conversationId: conversation.id, hasChannelToken: Boolean(credentials) });
    return;
  }

  const now = deps.now();
  const location = channel.locationId ? business.locations.find((l) => l.id === channel.locationId) : null;
  const turn: Turn = {
    db,
    deps,
    ctx,
    businessId,
    payload,
    conversation,
    message,
    client,
    clientPhone: client.phone,
    credentials,
    locationId: channel.locationId,
    texts: await loadTextProfile(db, businessId),
    timeZone: location?.timezone ?? business.business.timezone,
    now,
    effects: false,
  };

  // 2. Adjuntos: se bajan y guardan antes de mirar el modo (el operador también los ve).
  const media = payload.kind === "image" || payload.kind === "audio" ? await fetchMedia(turn) : null;

  // 3. Acciones directas (cualquier modo).
  if (payload.action === "appointment_reply") return handleAppointmentReply(turn);
  if (payload.action === "opt_out") return handleOptOut(turn);

  // 4. Modo humano (con vencimiento).
  if (turn.conversation.mode === "human") {
    const lastHuman = await lastHumanReplyAt(db, businessId, conversation.id);
    if (humanModeExpired(turn.conversation, lastHuman, now)) {
      await setConversationMode(db, businessId, conversation.id, "bot", now);
      turn.conversation = { ...turn.conversation, mode: "bot", humanSince: null };
      log.info("whatsapp_human_mode_expired", { businessId, conversationId: conversation.id });
    } else {
      await notify(turn, HUMAN_MODE_NOTE[payload.kind] ?? turn.message.content);
      return;
    }
  }

  // 5. Pedido explícito de una persona.
  if (payload.action === "human_request") return handleHumanRequest(turn, turn.message.content);

  // 6. Lo que el bot no lee.
  if (payload.kind === "document" || payload.kind === "contact" || payload.kind === "unsupported") {
    const key: PipelineTextKey = payload.kind === "document" ? "documentUnsupported" : payload.kind === "contact" ? "contactUnsupported" : "unsupportedMedia";
    await sendFixed(turn, key);
    await notify(turn, HUMAN_MODE_NOTE[payload.kind]);
    return;
  }
  if (payload.kind === "image" && !media) {
    await sendFixed(turn, "photoDownloadFailed");
    await notify(turn, "📷 Llegó una foto que no se pudo procesar.");
    return;
  }

  // 7. Frenos por cliente (antes de transcribir: Whisper también se paga).
  if (await applyClientBrakes(turn)) return;

  // 8. Audio → texto.
  let operatorNote = turn.message.content;
  if (payload.kind === "audio") {
    if (!media) {
      await sendFixed(turn, "audioFailed");
      await notify(turn, "🎤 Llegó una nota de voz que no se pudo descargar.");
      return;
    }
    let transcript: string;
    try {
      const result = await deps.transcribe(media.buffer, media.mimeType);
      transcript = result.text;
      await incrementAiUsage(db, businessId, { costMicros: whisperCostMicros(result.durationSec) }, now);
    } catch (e) {
      if (shouldRetry(turn, e)) throw e;
      log.warn("whatsapp_transcription_failed", { businessId, conversationId: conversation.id, error: short(e) });
      transcript = "";
    }
    if (!transcript) {
      await sendFixed(turn, "audioFailed");
      await notify(turn, "🎤 Llegó una nota de voz que no se pudo transcribir.");
      return;
    }
    const content = `[audio] ${transcript}`;
    await updateMessage(db, businessId, turn.message.id, { content });
    turn.message = { ...turn.message, content };
    operatorNote = `🎤 ${transcript}`;
    if (requestsHuman(transcript)) return handleHumanRequest(turn, operatorNote);
  }

  // 7b. Topes mensuales del plan.
  if (await applyMonthlyCaps(turn)) return;

  // 9–11. Turno del agente.
  await runAgentTurn(turn, operatorNote);
}
