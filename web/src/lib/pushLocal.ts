// ─────────────────────────────────────────────────────────────────────────────
// Suscripción push de ESTE navegador (revisión de seguridad 2026-10). La usa el logout:
// el backend borra la suscripción de este dispositivo (le mandamos su `endpoint`) y acá
// la damos de baja en el navegador, para que el próximo que se loguee en este mismo
// teléfono/tablet no herede los avisos del anterior — tiene que activarlos él con la 🔔.
// Todo es best-effort: si el navegador no soporta push o algo falla, el logout sigue.
// ─────────────────────────────────────────────────────────────────────────────

async function suscripcionLocal(): Promise<PushSubscription | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration("/panel/");
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Endpoint de la suscripción push de este navegador, o null si no hay. */
export async function endpointPushLocal(): Promise<string | null> {
  return (await suscripcionLocal())?.endpoint ?? null;
}

/** Da de baja la suscripción push de este navegador (no toca el backend). */
export async function desuscribirPushLocal(): Promise<void> {
  try {
    await (await suscripcionLocal())?.unsubscribe();
  } catch {
    // sin suscripción o el navegador no deja: nada que hacer
  }
}
