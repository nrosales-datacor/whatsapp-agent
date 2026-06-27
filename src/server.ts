import "dotenv/config";
import http from "node:http";
import { verificarWebhook, firmaValida } from "./whatsapp/client";
import { ingerirEntrante, responderEntrante } from "./handleWebhook";
import { RepositorioEnMemoria } from "./booking/inMemoryRepository";
import { RepositorioDrizzle } from "./booking/drizzleRepository";
import { crearDb } from "./db/client";
import { iniciarRecordatorios } from "./reminders/scheduler";
import { cargarTenants } from "./config/tenantStore";
import { calendarioConfigurado } from "./calendar/googleCalendar";
import { manejarPanel } from "./panel/router";
import { pushConfigurado } from "./panel/push";
import type { Repositorio } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Servidor del agente de WhatsApp (standalone, sin framework).
// Si hay DATABASE_URL en el entorno → guarda en PostgreSQL (Drizzle).
// Si no → usa el repositorio en memoria (ideal para probar; no persiste).
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const RUTA_WEBHOOK = "/webhook";

const repo: Repositorio = process.env.DATABASE_URL
  ? new RepositorioDrizzle(crearDb())
  : new RepositorioEnMemoria();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Página simple para confirmar que está vivo.
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Agente de WhatsApp corriendo ✅");
    return;
  }

  // Panel web (bandeja humana): /panel y /api/panel/*.
  if (await manejarPanel(req, res, repo, url.pathname)) return;

  if (url.pathname !== RUTA_WEBHOOK) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // 1) Verificación del webhook (Meta hace un GET al configurarlo).
  if (req.method === "GET") {
    const r = verificarWebhook(url.searchParams);
    if (r.ok) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(r.challenge ?? "");
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
    return;
  }

  // 2) Mensajes entrantes (POST).
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    const firma = req.headers["x-hub-signature-256"];
    if (!firmaValida(raw, typeof firma === "string" ? firma : null)) {
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    // FASE 1: persistir el entrante ANTES de responder 200. Si falla, devolvemos 500
    // y Meta reintenta — la deduplicación por waMessageId evita procesarlo dos veces.
    let pendiente;
    try {
      pendiente = await ingerirEntrante(body, repo);
    } catch (e) {
      console.error("[server] no se pudo persistir el mensaje entrante (Meta reintentará):", e);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
      return;
    }

    // FASE 2: respondemos 200 rápido y procesamos la respuesta (LLM) aparte.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("EVENT_RECEIVED");
    if (pendiente) {
      responderEntrante(pendiente, repo).catch((e) => console.error("[server] responderEntrante:", e));
    }
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

// Carga el registro de tenants (de la base, o fallback en memoria) ANTES de aceptar
// tráfico: ningún webhook ni login debe entrar con el caché vacío. (ROADMAP B2)
await cargarTenants();

// Datos de demo para desarrollo/diseño del panel. SOLO se siembran en el repo en
// memoria: si hay DATABASE_URL (base real), se ignora para no ensuciar producción.
if (process.env.SEED_DEMO && !process.env.DATABASE_URL) {
  const { seedDemo } = await import("./panel/seedDemo");
  await seedDemo(repo).catch((e) => console.error("[seed] error:", e));
} else if (process.env.SEED_DEMO) {
  console.warn("[seed] SEED_DEMO ignorado: hay DATABASE_URL. Los datos de demo solo se cargan en memoria.");
}

server.listen(PORT, () => {
  const modo = process.env.DATABASE_URL ? "PostgreSQL (Drizzle)" : "memoria (no persiste)";
  console.log(`Agente escuchando en http://localhost:${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}${RUTA_WEBHOOK}  ·  Almacenamiento: ${modo}`);
  console.log(`Google Calendar: ${calendarioConfigurado() ? "conectado ✅" : "no configurado (opcional)"}`);
  console.log(`Notificaciones push: ${pushConfigurado() ? "configuradas ✅" : "no configuradas (faltan llaves VAPID)"}`);

  // Recordatorios de cita por WhatsApp (día antes + mismo día).
  iniciarRecordatorios(repo);
});
