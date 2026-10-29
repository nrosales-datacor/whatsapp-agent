import { and, eq, isNull } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { invalidateBusinessContext } from "./context";
import { businesses } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist de primeros pasos del Inicio (I6): acá solo la marca de "oculta" en
// `businesses.onboarding_dismissed_at`. Qué pasos tiene y cuáles están hechos lo arma la
// composición (src/onboarding.ts), que ve los módulos de afuera del núcleo (WhatsApp, el plan).
// ─────────────────────────────────────────────────────────────────────────────

/** Oculta la checklist del negocio (idempotente: queda la primera fecha). */
export async function dismissOnboarding(executor: Executor, businessId: string, now: Date = new Date()): Promise<void> {
  await withTenant(executor, businessId, (tx) =>
    tx
      .update(businesses)
      .set({ onboardingDismissedAt: now })
      .where(and(eq(businesses.id, businessId), isNull(businesses.onboardingDismissedAt))),
  );
  invalidateBusinessContext(businessId);
}
