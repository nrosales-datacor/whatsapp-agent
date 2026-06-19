import "dotenv/config";

// ─────────────────────────────────────────────────────────────────────────────
// Apunta el webhook de la app de Meta a una URL pública (la del servidor).
//   Uso:  npx tsx scripts/configurarWebhook.ts https://TU-DOMINIO/webhook
// Lee el token, app secret y verify token del .env. El app_id lo saca solo.
// ─────────────────────────────────────────────────────────────────────────────

const url = process.argv[2];
if (!url) {
  console.error("Uso: npx tsx scripts/configurarWebhook.ts https://TU-DOMINIO/webhook");
  process.exit(1);
}

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const secret = process.env.WHATSAPP_APP_SECRET;
const vt = process.env.WHATSAPP_VERIFY_TOKEN;
if (!token || !secret || !vt) {
  console.error("Faltan WHATSAPP_ACCESS_TOKEN / WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN en el .env");
  process.exit(1);
}

const enc = encodeURIComponent;
const dbg = await (await fetch(`https://graph.facebook.com/debug_token?input_token=${enc(token)}&access_token=${enc(token)}`)).json();
const appId = dbg?.data?.app_id;
if (!appId) {
  console.error("No pude obtener el app_id desde el token:", JSON.stringify(dbg));
  process.exit(1);
}

const res = await fetch(`https://graph.facebook.com/v21.0/${appId}/subscriptions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    object: "whatsapp_business_account",
    callback_url: url,
    verify_token: vt,
    fields: "messages",
    access_token: `${appId}|${secret}`,
  }),
});
const j = await res.json();
console.log(j.error ? "❌ Error: " + j.error.message : "✅ Webhook apuntado a " + url);
