import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { formatAmount } from "../../platform/money/currency";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import { isTransientError } from "../../platform/net/transient";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { enqueue, PermanentJobError, type JobContext } from "../../platform/queue";
import { getBusinessContext } from "../business";
import { getService } from "../catalog";
import { getClient } from "../clients";
import { findSlots, listUpcomingAppointmentsForClient, type AppointmentView } from "../scheduling";
import { shortDate } from "./agent/time";
import { channelForLocation, credentialsOf, listConnectedWhatsAppBusinessIds } from "./channels";
import { ensureConversation, findConversation, lastInboundAt, saveOutgoingMessage } from "./conversations";
import { loadTextProfile, type WhatsAppDeps } from "./deps";
import type { ReplyButton } from "./graph";
import type { GrowthResolver } from "./growth";
import { readGrowthConfig } from "./growthSettings";
import { windowState } from "./rules";
import { quotes, type QuoteStatus } from "./schema";
import { interpolate, pipelineText } from "./texts";
import { incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Rescate de cotizaciones abandonadas (I6.3, portado de legacy/src/rescate).
//
//   1. Registro: el agente llama `record_quote` cuando da el precio de un servicio y el
//      cliente no agenda (una sola cotización ABIERTA por cliente y servicio: índice
//      parcial). Si después agenda ese servicio —por el agente o desde el panel— la
//      cotización se cierra: `booked` si fue solo, `recovered` (con el monto) si fue
//      después de un toque.
//   2. Barrido (loop con lease): por negocio con WhatsApp, `quote_recovery` en el plan y el
//      rescate activado: toque 1 a las cotizaciones `pending` con más de `waitHours`; toque
//      2 a las `first_touch` de hace más de un día (si el número tiene la plantilla). Lo
//      viejo (7 días) se descarta. Un job por toque (dedupe por cotización y toque).
//   3. Job: re-chequea (sigue abierta, el cliente no pidió la baja, no está hablando con
//      una persona, no tiene ya una cita próxima) y reclama el toque con un UPDATE
//      condicional (nunca dos). Toque 1 (dentro de la ventana de 24 h): texto con los
//      próximos horarios libres como botones. Toque 2 (o el 1 con la ventana cerrada): la
//      plantilla `quoteRecovery` del número ({{1}} cliente · {{2}} servicio · {{3}} monto).
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_QUOTE_TOUCH_JOB = "whatsapp.quote_touch";

/** Horas entre el primer y el segundo toque. */
const SECOND_TOUCH_AFTER_HOURS = () => Math.max(1, Math.floor(msFromEnv("QUOTE_RECOVERY_SECOND_TOUCH_HOURS", 24)));
/** Una cotización más vieja que esto ya no se rescata. */
const MAX_AGE_DAYS = 7;
/** Días hacia adelante en los que se buscan horarios para ofrecer en el primer toque. */
const SLOT_SEARCH_DAYS = 7;
const MAX_SLOT_BUTTONS = 3;
const OPEN_STATUSES: readonly QuoteStatus[] = ["pending", "first_touch", "second_touch"];

// ── 1. Registro y cierre ────────────────────────────────────────────────────

/**
 * Registra (o deja como estaba) la cotización ABIERTA de un servicio para un cliente.
 * Devuelve true si es nueva. Idempotente: repetir el precio no la duplica.
 */
export async function recordQuote(
  executor: Executor,
  businessId: string,
  input: { clientId: string; serviceId: string; amountCents: number; at?: Date },
): Promise<boolean> {
  const at = input.at ?? new Date();
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .insert(quotes)
      .values({ businessId, clientId: input.clientId, serviceId: input.serviceId, amountCents: Math.max(0, Math.round(input.amountCents)), createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning({ id: quotes.id }),
  );
  return rows.length > 0;
}

/**
 * Cierra las cotizaciones abiertas del cliente por los servicios de una cita recién
 * agendada: `booked` si no hubo toques, `recovered` (con el precio de esa línea) si sí.
 * Devuelve cuántas cerró. Se llama tras agendar desde el agente y desde el panel.
 */
export async function closeQuotesForAppointment(executor: Executor, businessId: string, appointment: AppointmentView): Promise<number> {
  const lines = appointment.services.filter((l): l is typeof l & { serviceId: string } => Boolean(l.serviceId));
  if (lines.length === 0) return 0;
  const priceOf = new Map(lines.map((l) => [l.serviceId, l.priceCents]));
  return withTenant(executor, businessId, async (tx) => {
    const open = await tx
      .select({ id: quotes.id, serviceId: quotes.serviceId, status: quotes.status })
      .from(quotes)
      .where(
        and(
          eq(quotes.businessId, businessId),
          eq(quotes.clientId, appointment.clientId),
          inArray(quotes.status, [...OPEN_STATUSES]),
          inArray(quotes.serviceId, [...priceOf.keys()]),
        ),
      )
      .for("update");
    for (const q of open) {
      const touched = q.status !== "pending";
      await tx
        .update(quotes)
        .set({
          status: touched ? "recovered" : "booked",
          appointmentId: appointment.id,
          recoveredCents: touched ? (priceOf.get(q.serviceId as string) ?? null) : null,
        })
        .where(eq(quotes.id, q.id));
    }
    return open.length;
  });
}

// ── 2. Barrido ──────────────────────────────────────────────────────────────

export interface QuoteTouchPayload {
  quoteId: string;
  touch: 1 | 2;
}

/** Encola los toques que corresponden y descarta lo viejo. */
export async function sweepQuoteRecovery(db: Executor, getGrowth: GrowthResolver, now: Date = new Date()): Promise<{ enqueued: number; discarded: number }> {
  let enqueued = 0;
  let discarded = 0;
  const tooOld = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000);
  for (const businessId of await listConnectedWhatsAppBusinessIds(db)) {
    if (!(await getGrowth(businessId)).quoteRecovery) continue;
    const config = (await readGrowthConfig(db, businessId)).quoteRecovery;
    if (!config.enabled) continue;

    const expired = await withTenant(db, businessId, (tx) =>
      tx
        .update(quotes)
        .set({ status: "discarded" })
        .where(and(eq(quotes.businessId, businessId), inArray(quotes.status, [...OPEN_STATUSES]), lt(quotes.createdAt, tooOld)))
        .returning({ id: quotes.id }),
    );
    discarded += expired.length;

    const firstDue = new Date(now.getTime() - config.waitHours * 3_600_000);
    const secondDue = new Date(now.getTime() - SECOND_TOUCH_AFTER_HOURS() * 3_600_000);
    const due = await withTenant(db, businessId, (tx) =>
      tx
        .select({ id: quotes.id, status: quotes.status })
        .from(quotes)
        .where(
          and(
            eq(quotes.businessId, businessId),
            or(
              and(eq(quotes.status, "pending"), lte(quotes.createdAt, firstDue)),
              and(eq(quotes.status, "first_touch"), lte(quotes.firstTouchAt, secondDue)),
            ),
          ),
        )
        .orderBy(quotes.createdAt)
        .limit(200),
    );
    for (const q of due) {
      const touch: 1 | 2 = q.status === "pending" ? 1 : 2;
      const result = await enqueue<QuoteTouchPayload>(db, {
        type: WHATSAPP_QUOTE_TOUCH_JOB,
        businessId,
        payload: { quoteId: q.id, touch },
        dedupeKey: `quote-touch:${q.id}:${touch}`,
        maxAttempts: 3,
      });
      if (result.created) enqueued++;
    }
  }
  return { enqueued, discarded };
}

export function startQuoteRecoveryLoop(options: { db: Executor; getGrowth: GrowthResolver; intervalMs?: number }): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("QUOTE_RECOVERY_INTERVAL_MS", 10 * 60_000);
  return startLeaderLoop({
    db: options.db,
    label: "whatsapp_quote_recovery",
    intervalMs,
    tick: async () => {
      const result = await sweepQuoteRecovery(options.db, options.getGrowth);
      if (result.enqueued > 0 || result.discarded > 0) log.info("whatsapp_quote_recovery_sweep", result);
    },
    onError: (e, phase) => {
      log.error("whatsapp_quote_recovery_sweep_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "whatsapp_quote_recovery", phase });
    },
    scalingHint: "Subí QUOTE_RECOVERY_INTERVAL_MS o revisá el índice de `quotes`.",
  });
}

// ── 3. Toques ───────────────────────────────────────────────────────────────

export type QuoteTouchOutcome = "sent_buttons" | "sent_template" | "closed" | "skipped" | "failed";

async function setStatus(db: Executor, businessId: string, quoteId: string, from: readonly QuoteStatus[], changes: Partial<typeof quotes.$inferInsert>): Promise<boolean> {
  const rows = await withTenant(db, businessId, (tx) =>
    tx
      .update(quotes)
      .set(changes)
      .where(and(eq(quotes.businessId, businessId), eq(quotes.id, quoteId), inArray(quotes.status, [...from])))
      .returning({ id: quotes.id }),
  );
  return rows.length > 0;
}

/** Hasta 3 horarios libres de los próximos días para el servicio (botones del primer toque). */
async function slotButtons(db: Executor, businessId: string, serviceId: string, locationId: string, timeZone: string, now: Date): Promise<ReplyButton[]> {
  try {
    const slots = await findSlots(db, businessId, {
      locationId,
      serviceIds: [serviceId],
      staffId: "any",
      from: now,
      to: new Date(now.getTime() + SLOT_SEARCH_DAYS * 86_400_000),
      now,
      onlineOnly: true,
    });
    const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone, ...opts }).format(d);
    const seen = new Set<string>();
    const buttons: ReplyButton[] = [];
    for (const slot of slots) {
      const date = fmt(slot.startsAt, { year: "numeric", month: "2-digit", day: "2-digit" });
      const time = fmt(slot.startsAt, { hour: "2-digit", minute: "2-digit", hour12: false });
      // Uno por día: más opciones reales que tres horas seguidas del mismo día.
      if (seen.has(date)) continue;
      seen.add(date);
      buttons.push({ id: `slot:${date}T${time}`, title: `${shortDate(date)} · ${time}`.slice(0, 20) });
      if (buttons.length >= MAX_SLOT_BUTTONS) break;
    }
    return buttons;
  } catch (e) {
    log.warn("whatsapp_quote_slots_failed", { businessId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return [];
  }
}

/** Corre un `whatsapp.quote_touch`. */
export async function handleQuoteTouchJob(rawPayload: unknown, ctx: JobContext, deps: WhatsAppDeps): Promise<QuoteTouchOutcome> {
  const p = rawPayload as Partial<QuoteTouchPayload> | null;
  const businessId = ctx.businessId;
  if (!businessId || typeof p?.quoteId !== "string" || (p.touch !== 1 && p.touch !== 2)) throw new PermanentJobError("whatsapp.quote_touch: payload inválido");
  const { quoteId, touch } = p as QuoteTouchPayload;
  const db = ctx.db;
  const now = deps.now();

  if (!(await deps.getGrowth(businessId)).quoteRecovery) return "skipped";
  const config = (await readGrowthConfig(db, businessId)).quoteRecovery;
  if (!config.enabled) return "skipped";
  const [quote] = await withTenant(db, businessId, (tx) => tx.select().from(quotes).where(and(eq(quotes.businessId, businessId), eq(quotes.id, quoteId))).limit(1));
  const expected: QuoteStatus = touch === 1 ? "pending" : "first_touch";
  if (!quote || quote.status !== expected || !quote.serviceId) return "skipped";

  const client = await getClient(db, businessId, quote.clientId);
  if (!client?.phone || client.anonymized) {
    await setStatus(db, businessId, quoteId, [expected], { status: "discarded" });
    return "closed";
  }
  // El rescate es promoción: quien pidió la baja no lo recibe.
  if (client.marketingOptOutAt) {
    await setStatus(db, businessId, quoteId, [expected], { status: "opted_out" });
    return "closed";
  }
  // Ya agendó algo (por otro lado): no se lo persigue.
  if ((await listUpcomingAppointmentsForClient(db, businessId, client.id, { now, limit: 1 })).length > 0) {
    await setStatus(db, businessId, quoteId, [expected], { status: "discarded" });
    return "closed";
  }
  const business = await getBusinessContext(db, businessId);
  const service = await getService(db, businessId, quote.serviceId);
  if (!business || !service || !service.active) {
    await setStatus(db, businessId, quoteId, [expected], { status: "discarded" });
    return "closed";
  }
  const locationId = client.preferredLocationId ?? (business.locations.length === 1 ? business.locations[0].id : null);
  const channel = await channelForLocation(db, businessId, locationId);
  const credentials = channel ? credentialsOf(channel) : null;
  if (!channel || !credentials) return "skipped";
  const existing = await findConversation(db, businessId, channel.id, client.id);
  // Una persona del equipo está atendiendo: el rescate automático no se mete.
  if (existing?.mode === "human") {
    await setStatus(db, businessId, quoteId, [expected], { status: "discarded" });
    return "closed";
  }
  const conversation = existing ?? (await ensureConversation(db, businessId, channel.id, client.id));
  const win = windowState(await lastInboundAt(db, businessId, conversation.id), now);
  const amount = quote.amountCents > 0 ? formatAmount(quote.amountCents / 100, business.business.currency) : "a cotizar";
  const template = channel.templates?.quoteRecovery;
  const viaText = touch === 1 && win.open;
  if (!viaText && !template) {
    // Fuera de la ventana y sin plantilla no hay cómo: se termina el rescate.
    await setStatus(db, businessId, quoteId, [expected], touch === 1 ? { status: "first_touch", firstTouchAt: now } : { status: "discarded" });
    return "skipped";
  }

  // Reclamo del toque (UPDATE condicional): un reintento o dos réplicas no mandan dos. La
  // plantilla es siempre el ÚLTIMO toque (aunque sea el primero, con la ventana cerrada):
  // nunca dos promociones por plantilla por la misma cotización.
  const claim: Partial<typeof quotes.$inferInsert> = viaText
    ? { status: "first_touch", firstTouchAt: now }
    : { status: "second_touch", secondTouchAt: now, ...(touch === 1 ? { firstTouchAt: now } : {}) };
  if (!(await setStatus(db, businessId, quoteId, [expected], claim))) return "skipped";
  const release = () =>
    setStatus(db, businessId, quoteId, [claim.status as QuoteStatus], touch === 1 ? { status: "pending", firstTouchAt: null, secondTouchAt: null } : { status: "first_touch", secondTouchAt: null });

  try {
    if (viaText) {
      const texts = await loadTextProfile(db, businessId);
      const vars = { servicio: service.name, monto: amount };
      const body = config.firstTouchText ? interpolate(config.firstTouchText, { negocio: business.business.name, ...vars }) : pipelineText(texts, "quoteFirstTouch", vars);
      const location = business.locations.find((l) => l.id === (channel.locationId ?? locationId));
      const buttons = location ? await slotButtons(db, businessId, service.id, location.id, location.timezone, now) : [];
      if (buttons.length > 0) await deps.api.sendButtons(credentials, client.phone, body, buttons);
      else await deps.api.sendText(credentials, client.phone, body);
      await saveOutgoingMessage(db, businessId, conversation.id, {
        content: buttons.length > 0 ? `${body}\n[${buttons.map((b) => b.title).join(" / ")}]` : body,
        at: now,
      });
      await incrementAiUsage(db, businessId, { messagesOut: 1 }, now);
      log.info("whatsapp_quote_touch_sent", { businessId, quoteId, touch, via: "text" });
      return "sent_buttons";
    }
    await deps.api.sendTemplate(credentials, client.phone, {
      name: (template as NonNullable<typeof template>).name,
      language: (template as NonNullable<typeof template>).language,
      bodyParams: [client.name, service.name, amount],
    });
    await saveOutgoingMessage(db, businessId, conversation.id, {
      content: `🔁 Seguimiento de cotización (plantilla "${(template as NonNullable<typeof template>).name}"): ${service.name}, ${amount}.`,
      at: now,
    });
    await incrementAiUsage(db, businessId, { messagesOut: 1, marketingTemplates: 1 }, now);
    log.info("whatsapp_quote_touch_sent", { businessId, quoteId, touch, via: "template" });
    return "sent_template";
  } catch (e) {
    await release();
    if (isTransientError(e) && !ctx.isLastAttempt) throw e;
    log.warn("whatsapp_quote_touch_failed", { businessId, quoteId, touch, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return "failed";
  }
}

// ── Métricas ────────────────────────────────────────────────────────────────

export interface QuoteStats {
  /** Cotizaciones registradas en el rango. */
  created: number;
  /** De esas, cuántas recibieron al menos un toque. */
  touched: number;
  /** Agendadas sin necesidad de rescate. */
  booked: number;
  /** Agendadas después de un toque (el rescate funcionó). */
  recovered: number;
  /** Lo agendado gracias al rescate, en céntimos. */
  recoveredCents: number;
}

export async function quoteStats(db: Executor, businessId: string, range: { from: Date; to: Date }): Promise<QuoteStats> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({
        created: sql<number>`count(*)::int`,
        touched: sql<number>`(count(*) FILTER (WHERE ${quotes.firstTouchAt} IS NOT NULL))::int`,
        booked: sql<number>`(count(*) FILTER (WHERE ${quotes.status} = 'booked'))::int`,
        recovered: sql<number>`(count(*) FILTER (WHERE ${quotes.status} = 'recovered'))::int`,
        recoveredCents: sql<number>`coalesce(sum(${quotes.recoveredCents}) FILTER (WHERE ${quotes.status} = 'recovered'), 0)::bigint`,
      })
      .from(quotes)
      .where(and(eq(quotes.businessId, businessId), gte(quotes.createdAt, range.from), lt(quotes.createdAt, range.to))),
  );
  return {
    created: Number(row?.created ?? 0),
    touched: Number(row?.touched ?? 0),
    booked: Number(row?.booked ?? 0),
    recovered: Number(row?.recovered ?? 0),
    recoveredCents: Number(row?.recoveredCents ?? 0),
  };
}
