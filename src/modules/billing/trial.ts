import { recordAudit } from "../../platform/audit/auditLog";
import type { Tx } from "../../platform/db/scope";
import { updateBusinessSubscription } from "../business";
import { trialEndFrom } from "./stripeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// Prueba del alta self-service (TRIAL_DAYS, default 14): el negocio queda en `trial` con
// `trial_ends_at`. Al vencer sin suscripción, el barrido (./sweep.ts) lo pausa por el cobro;
// si se suscribe antes, Stripe no cobra hasta que termine la prueba (./checkout.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arranca (o reinicia) la prueba DENTRO de la transacción del llamador, con su rastro. El
 * llamador invalida el caché del contexto después de confirmar. Devuelve el fin de la prueba.
 */
export async function startTrial(tx: Tx, businessId: string, actor: string, now: Date = new Date()): Promise<Date> {
  const trialEndsAt = trialEndFrom(now);
  const changed = await updateBusinessSubscription(tx, businessId, { billingStatus: "trial", trialEndsAt });
  if (!changed) throw new Error("startTrial: el negocio no existe");
  await recordAudit(tx, businessId, "trial_started", actor, { trialEndsAt: trialEndsAt.toISOString() });
  return trialEndsAt;
}
