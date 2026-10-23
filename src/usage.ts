import { getBusinessContext } from "./modules/business";
import type { PaymentRecordedHook } from "./modules/sales";
import { localDate, type AppointmentBookedHook } from "./modules/scheduling";
import { markMemberActive, type LoginHook, type SessionSeenHook } from "./modules/team";
import { withTenant, type Executor } from "./platform/db/scope";
import { incrementDailyUsage, USAGE_METRICS } from "./platform/observability/dailyUsage";
import { log } from "./platform/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de producto en `daily_usage` (PLAN-GESTION.md §2 "Medible", I5): la
// composición engancha los avisos que exponen los módulos (ninguno sabe de métricas) y
// suma por negocio y DÍA LOCAL del negocio:
//
//   • `appointments_created`  ← `onBooked` de la agenda (panel) y del agente de WhatsApp
//   • `payments_recorded`     ← `onRecorded` de ventas (señas y cobros)
//   • `logins`                ← `onLogin` de team
//   • `active_users`          ← cada request con sesión (`onSession`), UNA vez por persona y
//                               día: `markMemberActive` (team) lo deja atómico entre réplicas,
//                               y un caché del proceso evita escribir en cada request.
//   (`ai_conversations` lo suma el propio módulo WhatsApp al ingerir, en su transacción.)
//
// Todo es best-effort: corre después de confirmar la operación y un error solo se
// registra (una métrica nunca tumba una cita, un cobro ni un login). Lo usan src/app.ts
// (sesión), src/routes.ts (rutas) y src/jobs.ts (agente).
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageTracker {
  appointmentBooked: AppointmentBookedHook;
  paymentRecorded: PaymentRecordedHook;
  login: LoginHook;
  sessionSeen: SessionSeenHook;
}

export interface UsageTrackerOptions {
  /** Reloj (tests). */
  now?: () => Date;
  /** Personas recordadas por proceso para no marcar en cada request. Default 5000. */
  maxCachedMembers?: number;
}

const FALLBACK_TIMEZONE = "America/Costa_Rica";

export function createUsageTracker(options: UsageTrackerOptions = {}): UsageTracker {
  const now = options.now ?? (() => new Date());
  const maxCached = Math.max(1, options.maxCachedMembers ?? 5000);
  // "negocio:usuario" → último día ya marcado en este proceso (Map en orden de inserción = LRU simple).
  const seen = new Map<string, string>();

  async function today(executor: Executor, businessId: string): Promise<string> {
    const ctx = await getBusinessContext(executor, businessId);
    return localDate(now(), ctx?.business.timezone ?? FALLBACK_TIMEZONE);
  }

  async function bump(executor: Executor, businessId: string, metric: string): Promise<void> {
    try {
      await incrementDailyUsage(executor, businessId, { date: await today(executor, businessId), metric });
    } catch (error) {
      log.warn("daily_usage_increment_failed", { businessId, metric, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    appointmentBooked: (executor, businessId) => bump(executor, businessId, USAGE_METRICS.appointmentsCreated),
    paymentRecorded: (executor, businessId) => bump(executor, businessId, USAGE_METRICS.paymentsRecorded),
    login: (executor, businessId) => bump(executor, businessId, USAGE_METRICS.logins),
    async sessionSeen(executor, session) {
      const key = `${session.businessId}:${session.userId}`;
      try {
        const date = await today(executor, session.businessId);
        if (seen.get(key) === date) return;
        // Marca y contador en la misma transacción: o quedan los dos, o ninguno.
        await withTenant(executor, session.businessId, async (tx) => {
          const first = await markMemberActive(tx, session.businessId, session.userId, date);
          if (first) await incrementDailyUsage(tx, session.businessId, { date, metric: USAGE_METRICS.activeUsers });
        });
        seen.delete(key);
        seen.set(key, date);
        while (seen.size > maxCached) seen.delete(seen.keys().next().value as string);
      } catch (error) {
        log.warn("daily_usage_active_user_failed", { businessId: session.businessId, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
