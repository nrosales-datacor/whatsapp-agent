import * as Sentry from "@sentry/node";

// ─────────────────────────────────────────────────────────────────────────────
// Captura de errores. OPCIONAL: sin SENTRY_DSN todo es no-op — el producto funciona
// igual, solo sin reportes.
//
// Sentry.init() ya registra por defecto los handlers globales de:
//   • uncaughtException → captura y sale del proceso (PM2 reinicia igual).
//   • unhandledRejection → captura y SOLO avisa, no mata el proceso. Sin Sentry, un
//     rechazo sin manejar tumba TODO el proceso para todos los negocios (comportamiento
//     default de Node desde v15). Con Sentry activo queda reportado y el servidor sigue
//     en pie — mejora de fiabilidad de regalo, no solo alertas.
//
// Además de esos globales, `captureError` se llama a mano en los catch que ya atrapan el
// error (reintentos, loops) pero que, sin esto, solo lo mandarían a `console.error` sin
// que nadie se entere.
// ─────────────────────────────────────────────────────────────────────────────

const DSN = process.env.SENTRY_DSN;

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0, // solo errores, sin tracing de performance
  });
}

export function isSentryConfigured(): boolean {
  return Boolean(DSN);
}

/** Reporta a Sentry un error ya atrapado que vale la pena alertar. No-op sin DSN. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/**
 * Espera a que Sentry mande los eventos pendientes. Solo hace falta en scripts de vida
 * corta (p. ej. `scripts/backupDb.ts`), que terminan antes del envío async.
 */
export async function flushSentry(ms = 5000): Promise<void> {
  if (!DSN) return;
  await Sentry.flush(ms).catch(() => {});
}
