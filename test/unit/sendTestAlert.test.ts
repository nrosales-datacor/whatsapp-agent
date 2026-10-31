import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// scripts/sendTestAlert.ts (paso «mandá una alerta de prueba» de DEPLOY.md §22): contra un
// webhook LOCAL de prueba, el script hace el POST {text, content} de `test_alert` y sale
// con 0; si el canal responde error, o si solo está el log, sale con 1. Nunca lee un .env
// real (DOTENV_CONFIG_PATH=/dev/null) ni sale a la red.
// ─────────────────────────────────────────────────────────────────────────────

interface Received {
  method?: string;
  contentType?: string;
  body: { text?: string; content?: string };
}

async function withHookServer(status: number, fn: (url: string, received: Received[]) => Promise<void>): Promise<void> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ method: req.method, contentType: req.headers["content-type"], body: JSON.parse(raw || "{}") });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function runScript(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/sendTestAlert.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: "/dev/null",
        NODE_ENV: "test",
        SENTRY_DSN: "",
        ALERTS_WEBHOOK_URL: "",
        ALERTS_TELEGRAM_BOT_TOKEN: "",
        ALERTS_TELEGRAM_CHAT_ID: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("sendTestAlert: con un webhook local hace el POST {text, content} de test_alert y sale con 0", async () => {
  await withHookServer(200, async (url, received) => {
    const r = await runScript({ ALERTS_WEBHOOK_URL: url });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].contentType, "application/json");
    assert.match(received[0].body.text ?? "", /^⚠️ \[selyon-crm\/test\] test_alert: Alerta de prueba/);
    assert.equal(received[0].body.content, received[0].body.text);
    assert.match(r.stdout, /Canales configurados: log \+ webhook/);
    assert.match(r.stdout, /✅ webhook/);
    assert.ok(!r.stdout.includes(url), "no imprime la URL del webhook");
  });
});

test("sendTestAlert: si el canal responde error, sale con 1 y lo dice", async () => {
  await withHookServer(500, async (url) => {
    const r = await runScript({ ALERTS_WEBHOOK_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /❌ webhook: webhook de alertas respondió 500/);
  });
});

test("sendTestAlert: solo con el log (sin canales) sale con 1 y explica qué configurar", async () => {
  const r = await runScript({});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ALERTS_TELEGRAM_BOT_TOKEN/);
});
