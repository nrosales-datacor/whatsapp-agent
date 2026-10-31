import "dotenv/config";
import { alertPlatform, configuredAlertChannels, flushAlerts, TEST_ALERT } from "../src/platform/observability/alerts";
import { flushSentry, initSentry } from "../src/platform/observability/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Manda UNA alerta de prueba (`test_alert`) por todos los canales configurados en el
// .env (log, Sentry, webhook Slack/Discord, Telegram) y espera a que salgan. Es el paso
// "verificá que el canal llega" de DEPLOY.md §22: un canal que nunca se probó no cuenta.
//
//   Uso (en el servidor, desde la carpeta de la app):  npx tsx scripts/sendTestAlert.ts
//
// Sale con código 0 si todos los envíos HTTP (webhook/Telegram) respondieron OK; 1 si
// alguno falló o si no hay ningún canal además del log. No toca la base ni los negocios.
// Nunca imprime la URL del webhook ni el token del bot.
// ─────────────────────────────────────────────────────────────────────────────

initSentry();

const channels = configuredAlertChannels();
console.log(`Canales configurados: ${channels.join(" + ")}`);

alertPlatform({
  type: TEST_ALERT,
  severity: "warning",
  message: "Alerta de prueba: si te llegó, este canal de alertas funciona. No hay que hacer nada.",
  data: { source: "scripts/sendTestAlert.ts" },
  cooldownMs: 0,
});

const deliveries = await flushAlerts();
await flushSentry();

for (const d of deliveries) console.log(`  ${d.ok ? "✅" : "❌"} ${d.channel}${d.ok ? "" : `: ${d.error}`}`);
if (channels.includes("sentry")) console.log("  ↗ sentry: revisá que el evento «[alerta test_alert]» aparezca en el proyecto.");

if (channels.length === 1) {
  console.error("Solo está el log: configurá ALERTS_TELEGRAM_BOT_TOKEN + ALERTS_TELEGRAM_CHAT_ID (DEPLOY.md §22).");
  process.exit(1);
}
process.exit(deliveries.every((d) => d.ok) ? 0 : 1);
