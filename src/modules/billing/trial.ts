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
 * llamador invalida el caché del contexto después de confirmar. Con `onlyIfInTrial`, solo
 * la reinicia si el negocio sigue en una prueba con vencimiento (si el superadmin ya lo
 * pasó a otro estado, no se toca). Devuelve el fin de la prueba, o null si no la tocó.
 */
export async function startTrial(
  tx: Tx,
  businessId: string,
  actor: string,
  now: Date = new Date(),
  options: { onlyIfInTrial?: boolean } = {},
): Promise<Date | null> {
  const trialEndsAt = trialEndFrom(now);
  const state = { touched: false };
  const changed = await updateBusinessSubscription(tx, businessId, (current) => {
    if (options.onlyIfInTrial && (current.billingStatus !== "trial" || !current.trialEndsAt)) return {};
    state.touched = true;
    return { billingStatus: "trial", trialEndsAt };
  });
  if (!changed) throw new Error("startTrial: el negocio no existe");
  if (!state.touched) return null;
  await recordAudit(tx, businessId, "trial_started", actor, { trialEndsAt: trialEndsAt.toISOString() });
  return trialEndsAt;
}
