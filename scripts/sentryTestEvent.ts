import "dotenv/config";
import { captureError, currentRelease, flushSentry, initSentry, isSentryConfigured } from "../src/platform/observability/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Manda UN evento de prueba a Sentry para confirmar que el DSN del servidor funciona
// (DEPLOY.md §16). Uso, en el droplet, desde la carpeta del proyecto:
//
//   node --import tsx scripts/sentryTestEvent.ts      (o: npx tsx scripts/sentryTestEvent.ts)
//
// Lee SENTRY_DSN (y SENTRY_RELEASE, si está) del `.env`. Sin DSN no manda nada: lo dice y
// sale con 0 (no-op, como el resto del producto). Con DSN, el evento aparece en Sentry →
// Issues como "Evento de prueba de Sentry" con el tag `app:backend`; sirve también para
// probar la regla de alerta «nuevo issue → email/Slack». Sin datos de clientes.
// ─────────────────────────────────────────────────────────────────────────────

if (!isSentryConfigured()) {
  console.log("Sentry no configurado: falta SENTRY_DSN en el .env. No se mandó nada (no-op).");
  console.log("Para activarlo: DEPLOY.md §16.");
  process.exit(0);
}

initSentry();
const release = currentRelease();
const sentAt = new Date().toISOString();
captureError(new Error(`Evento de prueba de Sentry (${sentAt})`), { script: "sentryTestEvent", sentAt, release: release ?? null });

if (await flushSentry(10_000)) {
  console.log(`✅ Evento de prueba enviado (release ${release ?? "sin SENTRY_RELEASE"}). Buscalo en Sentry → Issues: "Evento de prueba de Sentry".`);
  process.exit(0);
}
console.error("❌ No se pudo confirmar el envío a Sentry en 10 s: revisá el DSN y la salida a internet del servidor.");
process.exit(1);
