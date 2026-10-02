import * as Sentry from "@sentry/node";

// ─────────────────────────────────────────────────────────────────────────────
// Captura de errores (ROADMAP B5). OPCIONAL: sin SENTRY_DSN todo es no-op,
// mismo patrón que Calendar/Push — el bot funciona igual, solo sin reportes.
//
// Sentry.init() ya registra por defecto los handlers globales de:
//   • uncaughtException → captura y sale del proceso (como el crash previo sin
//     Sentry; PM2 reinicia igual).
//   • unhandledRejection → captura y SOLO avisa, no mata el proceso. Antes, un
//     rechazo sin manejar en el callback async del server (ej. un throw dentro
//     de manejarPanel/manejarLanding) tumbaba TODO el proceso para todos los
//     tenants (comportamiento default de Node desde v15). Con Sentry activo
//     queda reportado pero el servidor sigue en pie — mejora de fiabilidad de
//     regalo, no solo alertas.
//
// Además de esos globales, `capturarError` se llama a mano en los catch de
// server.ts/worker.ts/scheduler.ts que ya atrapan el error (retries, loops)
// pero antes solo lo mandaban a `console.error` sin que nadie se enterara.
// ─────────────────────────────────────────────────────────────────────────────

const DSN = process.env.SENTRY_DSN;

export function iniciarSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0, // solo errores, sin tracing de performance
  });
}

export function sentryConfigurado(): boolean {
  return Boolean(DSN);
}

/** Reporta a Sentry un error ya atrapado que vale la pena alertar. No-op sin DSN. */
export function capturarError(error: unknown, contexto?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.captureException(error, contexto ? { extra: contexto } : undefined);
}

/**
 * Espera a que Sentry mande los eventos pendientes. Solo hace falta en scripts de
 * vida corta (p. ej. `scripts/backupDb.ts`), que terminan antes del envío async.
 */
export async function vaciarSentry(ms = 5000): Promise<void> {
  if (!DSN) return;
  await Sentry.flush(ms).catch(() => {});
}
