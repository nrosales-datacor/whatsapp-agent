import { sql } from "drizzle-orm";
import { getBusinessContext, minutesOfDay, type LocationWithHours } from "../business";
import { wallClock } from "../scheduling";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { alertPlatform, forgetAlert } from "../../platform/observability/alerts";
import { log } from "../../platform/observability/log";
import { numberFromEnv } from "../../platform/observability/rateAlert";
import { captureError } from "../../platform/observability/sentry";
import { listConnectedWhatsAppBusinessIds } from "./channels";

// ─────────────────────────────────────────────────────────────────────────────
// Vigilante «sin mensajes entrantes» (portado de la idea de
// legacy/src/observabilidad/vigilancia.ts). Hay fallas que dejan a UN negocio sin bot sin
// que nada falle de nuestro lado: Meta dejó de mandarnos sus webhooks (suscripción de la
// app perdida, número migrado, WABA deshabilitado). Ningún error aparece en los logs:
// simplemente no entra nada.
//
// Por negocio activo con número conectado y TRÁFICO HISTÓRICO (mensajes entrantes en los
// últimos 7 días), alerta `whatsapp_inbound_silent` si:
//   1. lleva `ALERTS_INBOUND_SILENCE_HOURS` (default 6) horas HÁBILES sin un mensaje
//      entrante — se cuentan solo los minutos en que alguna sucursal activa está abierta,
//      en su zona horaria (sin horario cargado, todas las horas cuentan);
//   2. con su ritmo de la última semana, en ese tramo hábil hubiera esperado al menos
//      `ALERTS_INBOUND_MIN_EXPECTED` (default 5) mensajes: el silencio de un negocio que
//      recibe 3 mensajes por semana no es señal;
//   3. ahora está abierto (no despierta a nadie a la madrugada por un negocio cerrado).
// Al volver a entrar mensajes, `forgetAlert`. `ALERTS_INBOUND_SILENCE_HOURS=0` lo apaga.
//
// Consulta acotada por índices: las conversaciones del negocio con actividad en la semana
// (conversations_business_activity_idx) y sus mensajes (messages_conversation_created_idx),
// con el contexto RLS del negocio. Sin datos personales en la alerta: id, horas y conteos.
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_INBOUND_SILENT_ALERT = "whatsapp_inbound_silent";

const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const STEP_MS = 15 * 60_000;
/** Recordatorio mientras el silencio siga (solo dentro del horario del negocio). */
const COOLDOWN_MS = 6 * 60 * 60_000;

export interface InboundWatchThresholds {
  /** Horas hábiles sin entrantes para alertar (0 = vigilante apagado). */
  silenceHours: number;
  /** Mensajes que el ritmo de la semana hubiera esperado en ese tramo, como mínimo. */
  minExpected: number;
}

export function inboundWatchThresholdsFromEnv(): InboundWatchThresholds {
  return {
    silenceHours: numberFromEnv("ALERTS_INBOUND_SILENCE_HOURS", 6, 0),
    minExpected: numberFromEnv("ALERTS_INBOUND_MIN_EXPECTED", 5, 0),
  };
}

/** Horario de una sucursal en minutos locales, para muestrear rápido. */
interface OpenSchedule {
  timeZone: string;
  /** Por día (0 = domingo): tramos [inicio, fin) en minutos locales. */
  byWeekday: Map<number, [number, number][]>;
}

function schedulesOf(locations: readonly LocationWithHours[]): OpenSchedule[] {
  return locations
    .filter((l) => l.active && l.hours.length > 0)
    .map((l) => {
      const byWeekday = new Map<number, [number, number][]>();
      for (const h of l.hours) {
        const blocks = byWeekday.get(h.weekday) ?? [];
        blocks.push([minutesOfDay(h.opensAt), minutesOfDay(h.closesAt)]);
        byWeekday.set(h.weekday, blocks);
      }
      return { timeZone: l.timezone, byWeekday };
    });
}

/** ¿Alguna sucursal abierta en `at`? Sin horarios cargados = siempre abierto. */
function isOpenAt(schedules: readonly OpenSchedule[], at: Date): boolean {
  if (schedules.length === 0) return true;
  return schedules.some((s) => {
    const clock = wallClock(at, s.timeZone);
    return (s.byWeekday.get(clock.weekday) ?? []).some(([start, end]) => clock.minute >= start && clock.minute < end);
  });
}

/** Minutos hábiles en [from, to), muestreando cada 15 min (precisión de sobra para horas). */
function openMinutesBetween(schedules: readonly OpenSchedule[], from: Date, to: Date): number {
  let total = 0;
  for (let t = from.getTime(); t < to.getTime(); t += STEP_MS) {
    if (isOpenAt(schedules, new Date(t))) total += Math.min(STEP_MS, to.getTime() - t);
  }
  return total / 60_000;
}

/** Entrantes del negocio desde `since`: cuántos y el último. */
async function readInboundTraffic(db: Executor, businessId: string, since: Date): Promise<{ count: number; lastAt: Date | null }> {
  const sinceIso = since.toISOString();
  const [row] = rowsOf<{ n: number | string; last_at: Date | string | null }>(
    await withTenant(db, businessId, (tx) =>
      tx.execute(sql`
        SELECT count(*) AS n, max(m.created_at) AS last_at
          FROM conversations c
          JOIN messages m ON m.conversation_id = c.id
         WHERE c.business_id = ${businessId}::uuid
           AND c.last_activity_at >= ${sinceIso}::timestamptz
           AND m.role = 'user'
           AND m.created_at >= ${sinceIso}::timestamptz
      `),
    ),
  );
  const lastAt = row?.last_at ?? null;
  return { count: Number(row?.n ?? 0), lastAt: lastAt === null ? null : lastAt instanceof Date ? lastAt : new Date(lastAt) };
}

export interface InboundSilence {
  businessId: string;
  silentOpenHours: number;
  expected: number;
}

/**
 * Un tick del vigilante: revisa cada negocio conectado y alerta los que están en silencio
 * anómalo. Devuelve los que alertaron en este tick.
 */
export async function checkInboundSilence(
  db: Executor,
  options: Partial<InboundWatchThresholds> = {},
  now: Date = new Date(),
): Promise<InboundSilence[]> {
  const t = { ...inboundWatchThresholdsFromEnv(), ...options };
  if (t.silenceHours <= 0) return [];
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const alerted: InboundSilence[] = [];
  for (const businessId of await listConnectedWhatsAppBusinessIds(db)) {
    const context = await getBusinessContext(db, businessId);
    if (!context || context.business.status !== "active") continue;
    const traffic = await readInboundTraffic(db, businessId, since);
    if (traffic.count === 0 || !traffic.lastAt) {
      forgetAlert(WHATSAPP_INBOUND_SILENT_ALERT, businessId); // sin tráfico reciente: nada que vigilar
      continue;
    }
    const schedules = schedulesOf(context.locations);
    const silentOpenMin = openMinutesBetween(schedules, traffic.lastAt, now);
    if (silentOpenMin < t.silenceHours * 60) {
      forgetAlert(WHATSAPP_INBOUND_SILENT_ALERT, businessId); // entró algo hace poco
      continue;
    }
    const weekOpenMin = Math.max(1, openMinutesBetween(schedules, since, now));
    const expected = (traffic.count * silentOpenMin) / weekOpenMin;
    if (expected < t.minExpected || !isOpenAt(schedules, now)) continue;
    const silentOpenHours = Math.round((silentOpenMin / 60) * 10) / 10;
    const fired = alertPlatform(
      {
        type: WHATSAPP_INBOUND_SILENT_ALERT,
        tenantId: businessId,
        severity: "warning",
        message: `${silentOpenHours} h hábiles sin mensajes entrantes de WhatsApp (con su ritmo de la semana se esperaban ~${Math.round(expected)}). ¿Meta dejó de mandar los webhooks del número?`,
        data: { silentOpenHours, expected: Math.round(expected), weeklyInbound: traffic.count, thresholdHours: t.silenceHours },
        cooldownMs: COOLDOWN_MS,
      },
      now.getTime(),
    );
    if (fired) alerted.push({ businessId, silentOpenHours, expected });
  }
  return alerted;
}

/**
 * Loop del vigilante (procesos `ROLE=worker|all`, una réplica por lease), cada
 * `ALERTS_CHECK_INTERVAL_MIN` (default 5). null si está apagado.
 */
export function startInboundWatchLoop(db: Executor, options: { intervalMs?: number } = {}): Loop | null {
  if (inboundWatchThresholdsFromEnv().silenceHours <= 0) return null;
  const intervalMs = options.intervalMs ?? numberFromEnv("ALERTS_CHECK_INTERVAL_MIN", 5, 1) * 60_000;
  return startLeaderLoop({
    db,
    label: "whatsapp_inbound_watch",
    intervalMs,
    tick: async () => {
      const alerted = await checkInboundSilence(db);
      if (alerted.length > 0) log.warn("whatsapp_inbound_silent", { businesses: alerted.length });
    },
    onError: (e, phase) => {
      log.error("whatsapp_inbound_watch_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "whatsapp_inbound_watch", phase });
    },
    scalingHint: "Subí ALERTS_CHECK_INTERVAL_MIN o apagá el vigilante con ALERTS_INBOUND_SILENCE_HOURS=0.",
  });
}
