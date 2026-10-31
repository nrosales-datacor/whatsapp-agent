import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  alertChannelsWarning,
  alertPlatform,
  configuredAlertChannels,
  flushAlerts,
  forgetAlert,
  _resetAlertsForTests,
  _setTelegramSenderForTests,
  _setWebhookSenderForTests,
} from "../../src/platform/observability/alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Canal de alertas a la plataforma (src/platform/observability/alerts.ts):
// deduplicación por (tipo, negocio) con cooldown, webhook genérico {text, content} y
// Telegram (Bot API `sendMessage`).
// ─────────────────────────────────────────────────────────────────────────────

let sent: { url: string; text: string; content: string }[] = [];
const previousUrl = process.env.ALERTS_WEBHOOK_URL;

beforeEach(() => {
  _resetAlertsForTests();
  sent = [];
  _setWebhookSenderForTests(async (url, body) => {
    sent.push({ url, ...body });
  });
  process.env.ALERTS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});

afterEach(() => {
  _setWebhookSenderForTests(null);
  if (previousUrl === undefined) delete process.env.ALERTS_WEBHOOK_URL;
  else process.env.ALERTS_WEBHOOK_URL = previousUrl;
});

const base = { type: "dlq_recent", severity: "critical" as const, message: "3 jobs en error" };

test("alertas: la primera ocurrencia sale por el webhook con {text, content}", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 1_000), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hooks.ejemplo.test/alertas");
  assert.match(sent[0].text, /dlq_recent/);
  assert.match(sent[0].text, /tenant t1/);
  assert.match(sent[0].text, /selyon-crm/);
  assert.equal(sent[0].text, sent[0].content, "Slack lee `text`, Discord lee `content`: mismo texto");
});

test("alertas: deduplica la misma (tipo, negocio) dentro del cooldown y vuelve a salir al vencer", () => {
  const cooldownMs = 60_000;
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 0), true);
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 30_000), false, "dentro del cooldown");
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 59_999), false);
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 60_000), true, "venció el cooldown");
  assert.equal(sent.length, 2);
});

test("alertas: el cooldown es por (tipo, negocio) — otro negocio u otro tipo no quedan silenciados", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(alertPlatform({ ...base, tenantId: "t2" }, 1), true, "otro negocio");
  assert.equal(alertPlatform({ ...base, type: "quota_exhausted", tenantId: "t1" }, 2), true, "otro tipo");
  assert.equal(alertPlatform({ ...base, type: "queue_stuck" }, 3), true, "global (sin negocio)");
  assert.equal(alertPlatform({ ...base, type: "queue_stuck" }, 4), false);
  assert.equal(sent.length, 4);
});

test("alertas: forgetAlert permite re-alertar de inmediato (problema resuelto y recaída)", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  forgetAlert("dlq_recent", "t1");
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 1), true);
});

test("alertas: sin ALERTS_WEBHOOK_URL no intenta el POST (solo log/Sentry) y no lanza", () => {
  delete process.env.ALERTS_WEBHOOK_URL;
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(sent.length, 0);
});

test("alertas: un webhook que falla no lanza ni rompe al llamador", async () => {
  _setWebhookSenderForTests(async () => {
    throw new Error("503 de Slack");
  });
  assert.doesNotThrow(() => alertPlatform({ ...base, tenantId: "t1" }, 0));
  await new Promise((r) => setImmediate(r)); // deja correr el catch del envío en segundo plano
});

// ── Telegram (canal elegido por el usuario, 2026-10-31) ─────────────────────

const TELEGRAM_VARS = ["ALERTS_TELEGRAM_BOT_TOKEN", "ALERTS_TELEGRAM_CHAT_ID"] as const;
// Valores inventados con forma reconocible (no son de ningún bot real).
const FAKE_BOT_TOKEN = "000000:token-de-prueba-no-real";
const FAKE_CHAT_ID = "-1001234567";

function withTelegramEnv(values: Partial<Record<(typeof TELEGRAM_VARS)[number], string>>, fn: () => Promise<void> | void) {
  return async () => {
    const previous = Object.fromEntries(TELEGRAM_VARS.map((k) => [k, process.env[k]]));
    for (const k of TELEGRAM_VARS) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
    try {
      await fn();
    } finally {
      _setTelegramSenderForTests(null);
      for (const k of TELEGRAM_VARS) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
    }
  };
}

test(
  "alertas: con bot + chat de Telegram, sale también por Telegram con el mismo texto",
  withTelegramEnv({ ALERTS_TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, ALERTS_TELEGRAM_CHAT_ID: FAKE_CHAT_ID }, async () => {
    const telegram: { botToken: string; chatId: string; text: string }[] = [];
    _setTelegramSenderForTests(async (botToken, chatId, text) => {
      telegram.push({ botToken, chatId, text });
    });
    assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
    const deliveries = await flushAlerts();
    assert.deepEqual(deliveries.map((d) => [d.channel, d.ok]).sort(), [["telegram", true], ["webhook", true]]);
    assert.equal(telegram.length, 1);
    assert.equal(telegram[0].botToken, FAKE_BOT_TOKEN);
    assert.equal(telegram[0].chatId, FAKE_CHAT_ID);
    assert.equal(telegram[0].text, sent[0].text, "mismo texto que el webhook");
    assert.ok(configuredAlertChannels().includes("telegram"));
  }),
);

test(
  "alertas: con una sola de las dos variables de Telegram no intenta el envío",
  withTelegramEnv({ ALERTS_TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN }, async () => {
    let calls = 0;
    _setTelegramSenderForTests(async () => {
      calls++;
    });
    alertPlatform({ ...base, tenantId: "t1" }, 0);
    await flushAlerts();
    assert.equal(calls, 0);
    assert.ok(!configuredAlertChannels().includes("telegram"));
  }),
);

test(
  "alertas: un fallo de Telegram no lanza y su error sale sin el token del bot",
  withTelegramEnv({ ALERTS_TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, ALERTS_TELEGRAM_CHAT_ID: FAKE_CHAT_ID }, async () => {
    _setTelegramSenderForTests(async (botToken) => {
      throw new Error(`fetch a https://api.telegram.org/bot${botToken}/sendMessage falló`);
    });
    assert.doesNotThrow(() => alertPlatform({ ...base, tenantId: "t1" }, 0));
    const telegram = (await flushAlerts()).find((d) => d.channel === "telegram");
    assert.equal(telegram?.ok, false);
    assert.ok(telegram?.error && !telegram.error.includes(FAKE_BOT_TOKEN), "el token no aparece en el error");
  }),
);

test("alertas: configuredAlertChannels lee el entorno que se le pasa", () => {
  assert.deepEqual(configuredAlertChannels({}), ["log"]);
  assert.deepEqual(
    configuredAlertChannels({ SENTRY_DSN: "https://k@o0.ingest.sentry.io/1", ALERTS_WEBHOOK_URL: "https://h", ALERTS_TELEGRAM_BOT_TOKEN: "x", ALERTS_TELEGRAM_CHAT_ID: "1" }),
    ["log", "sentry", "webhook", "telegram"],
  );
  assert.deepEqual(configuredAlertChannels({ ALERTS_WEBHOOK_URL: "   " }), ["log"], "vacía = sin canal");
});

test("alertas: aviso de arranque en producción si solo queda el log (o Telegram a medias)", () => {
  assert.equal(alertChannelsWarning({}), null, "fuera de producción no avisa");
  assert.match(alertChannelsWarning({ NODE_ENV: "production" }) ?? "", /solo por log/);
  assert.match(alertChannelsWarning({ NODE_ENV: "production", ALERTS_TELEGRAM_CHAT_ID: "1" }) ?? "", /medio configurar/);
  assert.match(
    alertChannelsWarning({ NODE_ENV: "production", ALERTS_TELEGRAM_BOT_TOKEN: "x", SENTRY_DSN: "https://k@o0.ingest.sentry.io/1" }) ?? "",
    /medio configurar/,
    "Telegram a medias avisa aunque haya otro canal",
  );
  assert.equal(alertChannelsWarning({ NODE_ENV: "production", ALERTS_TELEGRAM_BOT_TOKEN: "x", ALERTS_TELEGRAM_CHAT_ID: "1" }), null);
  assert.equal(alertChannelsWarning({ NODE_ENV: "production", ALERTS_WEBHOOK_URL: "https://h" }), null);
});
