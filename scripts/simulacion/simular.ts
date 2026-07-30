/* eslint-disable @typescript-eslint/no-explicit-any */
// ─────────────────────────────────────────────────────────────────────────────
// SIMULADOR DE CONVERSACIONES REALES (diagnóstico de comportamiento).
//
// Dispara payloads de webhook de WhatsApp firmados contra el servidor REAL
// (src/server.ts) y reporta, por caso: latencia del ACK a Meta, latencia hasta que
// el cliente recibe la respuesta, y el TEXTO EXACTO que le llegaría.
//
// Corre en DOS fases, porque producción y desarrollo NO usan el mismo camino:
//
//   FASE A — HTTP real contra src/server.ts, repositorio EN MEMORIA.
//     Cubre: firma X-Hub-Signature-256, ruteo, las 2 fases del webhook, el agente
//     real (OpenAI de verdad) y el envío al cliente. Procesa INLINE (sin cola),
//     que es lo que hace el server cuando no hay DATABASE_URL (src/server.ts:111).
//
//   FASE B — camino de PRODUCCIÓN: Postgres real (PGlite in-process) + wa_jobs +
//     el worker real de src/queue/worker.ts. Es el único camino donde se ve el
//     comportamiento serial de la cola y la reconstrucción del job desde su payload.
//     Se corren acá los casos donde A y B pueden diferir (ráfaga y duplicado).
//
// SEGURIDAD (principio 2 de TESTING.md — nunca tocar producción):
//   • NO se carga el .env real (DOTENV_CONFIG_PATH apunta a un archivo inexistente).
//     De ahí solo se extrae OPENAI_API_KEY, a mano, para que el agente sea real.
//   • DATABASE_URL se borra del entorno → jamás se escribe en la Supabase real.
//   • GOOGLE_* se borran → no se crean eventos en el Google Calendar real.
//   • El fetch a graph.facebook.com está interceptado: NINGÚN mensaje sale a
//     WhatsApp. Cualquier host no previsto hace fallar el script a propósito.
//
// Uso:  npx tsx scripts/simulacion/simular.ts [filtro]
//       npx tsx scripts/simulacion/simular.ts audio     (corre solo ese caso)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

// ── (1) Aislamiento del entorno. ANTES de importar cualquier módulo de src/ ──

/**
 * Lee UNA sola variable del .env real. Se usa solo para OPENAI_API_KEY: queremos el
 * agente de verdad (no un mock), pero sin cargar el resto del .env — que trae la
 * DATABASE_URL de producción, el token de WhatsApp del negocio y el Calendar real.
 */
function leerDelEnvReal(clave: string): string | undefined {
  const ruta = path.join(RAIZ, ".env");
  if (!existsSync(ruta)) return undefined;
  for (const linea of readFileSync(ruta, "utf8").split("\n")) {
    const t = linea.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    if (t.slice(0, i).trim() !== clave) continue;
    return t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? leerDelEnvReal("OPENAI_API_KEY");
if (!OPENAI_KEY) {
  console.error("❌ No encontré OPENAI_API_KEY (ni en el entorno ni en .env). El simulador necesita el agente real.");
  process.exit(1);
}

// src/server.ts hace `import "dotenv/config"`: lo apuntamos a un archivo inexistente
// para que no cargue nada, y limpiamos lo que el shell pudiera traer.
process.env.DOTENV_CONFIG_PATH = path.join(RAIZ, "scripts/simulacion/.env.inexistente");
delete process.env.DATABASE_URL; // ← repositorio en memoria; nunca Supabase
delete process.env.GOOGLE_CALENDAR_ID; // ← no crear eventos reales
delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
delete process.env.GOOGLE_PRIVATE_KEY;
delete process.env.SENTRY_DSN;
delete process.env.WHATSAPP_TEMPLATE_RECORDATORIO; // el .env real la tiene seteada
delete process.env.SEED_DEMO;

const PUERTO = 4599;
const PNID = "SIMULACION_PNID";
const APP_SECRET = "secreto-de-simulacion";

process.env.NODE_ENV = "test";
process.env.PORT = String(PUERTO);
process.env.OPENAI_API_KEY = OPENAI_KEY;
process.env.OPENAI_MODEL = process.env.OPENAI_MODEL ?? leerDelEnvReal("OPENAI_MODEL") ?? "gpt-4o-mini";
process.env.WHATSAPP_PHONE_NUMBER_ID = PNID;
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = "verify-de-simulacion";
process.env.WHATSAPP_ACCESS_TOKEN = "token-dummy-nunca-viaja";
process.env.PANEL_SESSION_SECRET = "secreto-de-sesion-para-la-simulacion-0123456789";
process.env.PANEL_PASSWORD_HASH_SELYON = "x:y"; // el store necesita algo; no se usa acá
process.env.RECORDATORIOS_INTERVALO_MIN = "10000"; // que no dispare recordatorios a mitad
process.env.METRICAS_INTERVALO_MIN = "10000";
process.env.TENANTS_REFRESH_MS = "0";

// ── (2) Mock de red. OpenAI pasa de verdad; Graph se intercepta; el resto explota ──

interface Saliente {
  ts: number;
  to: string;
  tipo: string;
  texto?: string;
  interactivo?: any;
}

const salientes: Saliente[] = [];
let llamadasOpenAI = 0;
let audioSimulado: { bytes: Buffer; mime: string } | null = null;

const fetchOriginal = globalThis.fetch;

globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  const metodo = String(init?.method ?? input?.method ?? "GET").toUpperCase();

  // OpenAI: pasa a la red REAL (queremos el comportamiento verdadero del agente).
  if (url.includes("api.openai.com")) {
    if (url.includes("/chat/completions")) llamadasOpenAI++;
    return fetchOriginal(input, init);
  }

  // Graph API — envío al cliente. Se captura, NO sale a la red.
  if (url.includes("graph.facebook.com") && url.includes("/messages") && metodo === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    salientes.push({
      ts: Date.now(),
      to: String(body.to ?? ""),
      tipo: String(body.type ?? "?"),
      texto: body.type === "text" ? body.text?.body : undefined,
      interactivo: body.type === "interactive" ? body.interactive : undefined,
    });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.sim.${salientes.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Graph API — metadata del media (paso 1 de la descarga).
  if (url.includes("graph.facebook.com") && metodo === "GET") {
    return new Response(JSON.stringify({ url: "https://sim.media/nota-de-voz", mime_type: audioSimulado?.mime ?? "audio/ogg" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Graph API — bytes del media (paso 2): la nota de voz que generamos con TTS.
  if (url.startsWith("https://sim.media/")) {
    if (!audioSimulado) throw new Error("simulacion: se pidió el audio antes de generarlo");
    return new Response(new Uint8Array(audioSimulado.bytes), {
      status: 200,
      headers: { "content-type": audioSimulado.mime },
    });
  }

  // Localhost: son mis propios POST al webhook.
  if (url.includes("localhost") || url.includes("127.0.0.1")) return fetchOriginal(input, init);

  throw new Error(`simulacion: host no permitido (posible fuga a producción): ${metodo} ${url}`);
}) as typeof globalThis.fetch;

// ── (3) Utilidades ──

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function firmar(cuerpo: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(cuerpo).digest("hex");
}

let contadorWamid = 0;
const nuevoWamid = () => `wamid.SIM${Date.now()}${++contadorWamid}`;

function cuerpoTexto(clienteWa: string, texto: string, messageId = nuevoWamid()) {
  return {
    messageId,
    body: {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PNID },
                messages: [{ from: clienteWa, id: messageId, type: "text", text: { body: texto } }],
              },
            },
          ],
        },
      ],
    },
  };
}

function cuerpoAudio(clienteWa: string, messageId = nuevoWamid()) {
  return {
    messageId,
    body: {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PNID },
                messages: [{ from: clienteWa, id: messageId, type: "audio", audio: { id: "media-sim-1", mime_type: "audio/ogg" } }],
              },
            },
          ],
        },
      ],
    },
  };
}

/** POST firmado al webhook real. Devuelve el status y cuánto tardó el ACK. */
async function enviarWebhook(body: unknown): Promise<{ status: number; ackMs: number }> {
  const crudo = JSON.stringify(body);
  const t0 = performance.now();
  const res = await fetchOriginal(`http://localhost:${PUERTO}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": firmar(crudo) },
    body: crudo,
  });
  await res.text();
  return { status: res.status, ackMs: performance.now() - t0 };
}

/**
 * Espera a que dejen de llegar salientes para ese cliente. `quietMs` es el silencio
 * que damos por "ya terminó" (el bot podría mandar más de un mensaje por turno).
 */
async function esperarSalientes(
  clienteWa: string,
  desdeIndice: number,
  opts: { minimo?: number; quietMs?: number; timeoutMs?: number } = {},
): Promise<Saliente[]> {
  const { minimo = 1, quietMs = 2500, timeoutMs = 90_000 } = opts;
  const t0 = Date.now();
  let ultimoConteo = -1;
  let ultimoCambio = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const propios = salientes.slice(desdeIndice).filter((s) => s.to === clienteWa);
    if (propios.length !== ultimoConteo) {
      ultimoConteo = propios.length;
      ultimoCambio = Date.now();
    }
    if (propios.length >= minimo && Date.now() - ultimoCambio > quietMs) return propios;
    await dormir(120);
  }
  return salientes.slice(desdeIndice).filter((s) => s.to === clienteWa);
}

/** Render legible de lo que el cliente vería en su WhatsApp. */
function renderSaliente(s: Saliente): string {
  if (s.tipo === "text") return s.texto ?? "";
  if (s.tipo === "interactive") {
    const i = s.interactivo ?? {};
    const cuerpo = i.body?.text ?? "";
    if (i.type === "button") {
      const bts = (i.action?.buttons ?? []).map((b: any) => `[ ${b.reply?.title} ]`).join("  ");
      return `${cuerpo}\n   ⌸ botones: ${bts}`;
    }
    const filas = (i.action?.sections?.[0]?.rows ?? []).map((f: any) => f.title).join(" · ");
    return `${cuerpo}\n   ⌸ lista "${i.action?.button}": ${filas}`;
  }
  return `(${s.tipo}) ${JSON.stringify(s.interactivo ?? s.texto ?? "")}`;
}

function bloque(txt: string, sangria = "      "): string {
  return txt
    .split("\n")
    .map((l) => sangria + l)
    .join("\n");
}

const ms = (n: number) => `${Math.round(n)} ms`;
const seg = (n: number) => `${(n / 1000).toFixed(2)} s`;

// ── (4) Nota de voz real, generada con TTS (para ejercitar Whisper de verdad) ──

async function generarNotaDeVoz(texto: string): Promise<{ bytes: Buffer; mime: string }> {
  const cache = path.join(os.tmpdir(), "simulacion-wa-nota-de-voz.ogg");
  if (existsSync(cache)) return { bytes: readFileSync(cache), mime: "audio/ogg" };
  const res = await fetchOriginal("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "nova", input: texto, response_format: "opus" }),
  });
  if (!res.ok) throw new Error(`TTS falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, bytes);
  return { bytes, mime: "audio/ogg" };
}

// ── (5) Arranque del servidor real ──

console.log("═".repeat(78));
console.log(" SIMULACIÓN DE CONVERSACIONES — servidor real, agente real, WhatsApp mockeado");
console.log("═".repeat(78));
console.log(` modelo: ${process.env.OPENAI_MODEL} · puerto: ${PUERTO} · DATABASE_URL: (borrada)`);
console.log(` Google Calendar: apagado · envíos a Meta: interceptados\n`);

const logOriginal = console.log;
console.log = () => {}; // silenciar el arranque ruidoso del server
await import("../../src/server");
await dormir(700);
console.log = logOriginal;

const { listarTenants } = await import("../../src/config/tenantStore");
const tenant = listarTenants()[0];
console.log(`Tenant cargado: "${tenant.nombre}" (${tenant.id}) · pnid=${tenant.phoneNumberId}`);
console.log(`Servicios agendables: ${tenant.servicios.filter((s) => s.agendable).map((s) => s.id).join(", ")}\n`);

const filtro = process.argv[2]?.toLowerCase();
const resultados: { caso: string; ok: boolean | "duda"; nota: string }[] = [];
const corre = (n: string) => !filtro || n.toLowerCase().includes(filtro);

// ── (6) FASE A — casos por HTTP contra el server real ──

console.log("━".repeat(78));
console.log(" FASE A — HTTP real → src/server.ts (repo en memoria, procesamiento inline)");
console.log("━".repeat(78));

interface CasoSimple {
  nombre: string;
  clienteWa: string;
  texto: string;
  esperado: string;
}

const CASOS: CasoSimple[] = [
  {
    nombre: "1. Saludo simple",
    clienteWa: "50611110001",
    texto: "hola",
    esperado: "Saludo corto + oferta de ayuda. Debe incluir el aviso de bot (primer contacto).",
  },
  {
    nombre: "2. Consulta de precio",
    clienteWa: "50611110002",
    texto: "buenas, cuánto me cobran por hacer una app móvil?",
    esperado: "NO debe dar un precio (política del tenant). Debe ofrecer la reunión de diagnóstico.",
  },
  {
    nombre: "3. Pedido de cita",
    clienteWa: "50611110003",
    texto: "quiero agendar una reunión de diagnóstico para mañana en la mañana",
    esperado: "Debe consultar disponibilidad real y ofrecer horarios (lista tocable), sin inventarlos.",
  },
  {
    nombre: "5. Pregunta fuera de alcance",
    clienteWa: "50611110005",
    texto: "me escribís un poema sobre el mar y me explicás cómo hacer arroz con pollo?",
    esperado: "Debe rehusar con amabilidad y reconducir. NO debe escalar a humano.",
  },
];

for (const caso of CASOS) {
  if (!corre(caso.nombre)) continue;
  const desde = salientes.length;
  const { messageId, body } = cuerpoTexto(caso.clienteWa, caso.texto);
  const tEnvio = Date.now();
  const { status, ackMs } = await enviarWebhook(body);
  const recibidos = await esperarSalientes(caso.clienteWa, desde);

  console.log(`\n${caso.nombre}`);
  console.log(`   cliente dice → "${caso.texto}"`);
  console.log(`   ACK a Meta: HTTP ${status} en ${ms(ackMs)}`);
  if (recibidos.length === 0) {
    console.log(`   ⛔ el cliente NO recibió NADA (timeout 90 s)`);
    resultados.push({ caso: caso.nombre, ok: false, nota: "sin respuesta" });
    continue;
  }
  console.log(`   respuesta al cliente: ${seg(recibidos[0].ts - tEnvio)} (mensajes: ${recibidos.length})`);
  recibidos.forEach((s, i) => {
    console.log(`   ┌─ mensaje ${i + 1} [${s.tipo}]`);
    console.log(bloque(renderSaliente(s)));
    console.log(`   └─`);
  });
  console.log(`   esperado: ${caso.esperado}`);
  resultados.push({ caso: caso.nombre, ok: "duda", nota: `${recibidos.length} msg · ${seg(recibidos[0].ts - tEnvio)}` });
  void messageId;
}

// ── Caso 4: nota de voz (audio real → Whisper real) ──
if (corre("4. Nota de voz") || corre("audio")) {
  const clienteWa = "50611110004";
  const frase = "Hola, buenas tardes. Quería saber si ustedes hacen bots de WhatsApp para negocios.";
  console.log(`\n4. Nota de voz (audio real)`);
  console.log(`   generando la nota de voz con TTS…`);
  audioSimulado = await generarNotaDeVoz(frase);
  console.log(`   audio: ${audioSimulado.bytes.length} bytes (${audioSimulado.mime}) · dice: "${frase}"`);

  const desde = salientes.length;
  const { body } = cuerpoAudio(clienteWa);
  const tEnvio = Date.now();
  const { status, ackMs } = await enviarWebhook(body);
  const recibidos = await esperarSalientes(clienteWa, desde);
  console.log(`   ACK a Meta: HTTP ${status} en ${ms(ackMs)}`);
  if (recibidos.length === 0) {
    console.log(`   ⛔ el cliente NO recibió NADA`);
    resultados.push({ caso: "4. Nota de voz", ok: false, nota: "sin respuesta" });
  } else {
    console.log(`   respuesta al cliente: ${seg(recibidos[0].ts - tEnvio)} (mensajes: ${recibidos.length})`);
    recibidos.forEach((s, i) => {
      console.log(`   ┌─ mensaje ${i + 1} [${s.tipo}]`);
      console.log(bloque(renderSaliente(s)));
      console.log(`   └─`);
    });
    console.log(`   esperado: transcribe el audio y responde al CONTENIDO (no "no puedo escucharlo").`);
    resultados.push({ caso: "4. Nota de voz", ok: "duda", nota: `${recibidos.length} msg · ${seg(recibidos[0].ts - tEnvio)}` });
  }
}

// ── (7) FASE B — camino de producción: PGlite + wa_jobs + worker real ──

console.log(`\n${"━".repeat(78)}`);
console.log(" FASE B — camino de PRODUCCIÓN: Postgres real (PGlite) + wa_jobs + worker");
console.log("━".repeat(78));

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const { migrate } = await import("drizzle-orm/pglite/migrator");
const { schema } = await import("../../src/db/schema");
const { RepositorioDrizzle } = await import("../../src/booking/drizzleRepository");
const { ingerirEntrante } = await import("../../src/handleWebhook");
const { iniciarWorker } = await import("../../src/queue/worker");
const { sql } = await import("drizzle-orm");

const cliente = new PGlite();
const dbPg = drizzle(cliente, { schema }) as any;
await migrate(dbPg, { migrationsFolder: path.join(RAIZ, "drizzle") });
const repoPg = new RepositorioDrizzle(dbPg);
console.log(" Postgres efímero listo (migraciones reales aplicadas).\n");

/** Reproduce lo que hace src/server.ts en producción: Fase 1 síncrona → 200 → cola. */
async function ingestarComoProduccion(body: unknown): Promise<{ ackMs: number; encolado: boolean }> {
  const t0 = performance.now();
  const pendiente = await ingerirEntrante(body, repoPg);
  return { ackMs: performance.now() - t0, encolado: !!pendiente };
}

const contarJobs = async () =>
  Number((await dbPg.execute(sql`SELECT count(*)::int AS n FROM wa_jobs`)).rows?.[0]?.n ?? 0);

// El worker real consume wa_jobs en serie (igual que producción). Arranca una vez.
iniciarWorker(repoPg, dbPg);
await dormir(300);

/**
 * Espera a que la cola quede DRENADA (sin jobs pendientes ni en proceso). Es una
 * señal exacta de "el bot ya terminó de responder todo", a diferencia de esperar un
 * silencio de N segundos — que subcuenta las respuestas cuando el worker es lento
 * (poll de 1 s) o la API tarda, y hace que un caso se coma las respuestas del otro.
 */
async function esperarColaDrenada(timeoutMs = 180_000): Promise<void> {
  const t0 = Date.now();
  let vacíaDesde = 0;
  while (Date.now() - t0 < timeoutMs) {
    const r = await dbPg.execute(
      sql`SELECT count(*)::int AS n FROM wa_jobs WHERE estado IN ('pendiente','procesando')`,
    );
    const n = Number((r.rows ?? r)[0]?.n ?? 0);
    if (n === 0) {
      // Dos lecturas seguidas en cero: el envío a Graph ocurre justo antes de marcar
      // el job como hecho, así que damos un respiro para que el saliente se registre.
      if (vacíaDesde && Date.now() - vacíaDesde > 800) return;
      if (!vacíaDesde) vacíaDesde = Date.now();
    } else {
      vacíaDesde = 0;
    }
    await dormir(200);
  }
  console.log("   ⚠️  la cola no se drenó dentro del timeout");
}

/** Un turno completo por el camino de producción: ingesta → cola → worker → respuesta. */
async function turnoProduccion(
  clienteWa: string,
  texto: string,
  etiqueta: string,
): Promise<Saliente[]> {
  const desde = salientes.length;
  const { body } = cuerpoTexto(clienteWa, texto);
  await ingestarComoProduccion(body);
  await esperarColaDrenada();
  const recibidos = salientes.slice(desde).filter((s) => s.to === clienteWa);
  console.log(`   ${etiqueta} cliente → "${texto}"`);
  if (recibidos.length === 0) {
    console.log(`      ⛔ sin respuesta`);
    return recibidos;
  }
  for (const s of recibidos) {
    console.log(`      bot [${s.tipo}] ↓`);
    console.log(bloque(renderSaliente(s), "         "));
  }
  return recibidos;
}

// ── Caso 6: tres mensajes seguidos en 2 segundos ──
if (corre("6. Ráfaga") || corre("rafaga") || corre("tres")) {
  const clienteWa = "50622220006";
  const mensajes = ["hola buenas", "quiero agendar una reunión", "para mañana si se puede"];
  console.log(`6. Tres mensajes seguidos en 2 s (mismo cliente)`);
  mensajes.forEach((m, i) => console.log(`   cliente dice (${i + 1}) → "${m}"`));

  const desde = salientes.length;
  const tEnvio = Date.now();
  for (let i = 0; i < mensajes.length; i++) {
    const { body } = cuerpoTexto(clienteWa, mensajes[i]);
    const { ackMs, encolado } = await ingestarComoProduccion(body);
    console.log(`   ingesta ${i + 1}: ACK ${ms(ackMs)} · encolado=${encolado}`);
    if (i < mensajes.length - 1) await dormir(700);
  }
  console.log(`   jobs en wa_jobs: ${await contarJobs()}`);
  await esperarColaDrenada();
  const recibidos = salientes.slice(desde).filter((s) => s.to === clienteWa);
  console.log(`   el cliente recibió ${recibidos.length} mensaje(s):`);
  recibidos.forEach((s, i) => {
    console.log(`   ┌─ respuesta ${i + 1} [${s.tipo}] · +${seg(s.ts - tEnvio)}`);
    console.log(bloque(renderSaliente(s)));
    console.log(`   └─`);
  });
  console.log(`   esperado: UNA conversación coherente. Si son 3 respuestas que se saludan`);
  console.log(`             de nuevo o repiten preguntas, el snapshot de historial está viciado.`);
  const avisos = recibidos.filter((s) => (s.texto ?? "").includes("asistente automatizado")).length;
  console.log(`   veces que se repitió el aviso de bot ("asistente automatizado"): ${avisos}`);
  resultados.push({
    caso: "6. Ráfaga de 3 mensajes",
    ok: recibidos.length === 1,
    nota: `${recibidos.length} respuestas para 3 mensajes · aviso de bot repetido ${avisos}x`,
  });
}

// ── Caso 7: el mismo message.id dos veces (reintento de Meta) ──
if (corre("7. Duplicado") || corre("duplicado") || corre("dedup")) {
  const clienteWa = "50622220007";
  const wamid = nuevoWamid();
  console.log(`\n7. Mismo message.id enviado dos veces (reintento de Meta)`);
  console.log(`   wamid: ${wamid}`);

  const desde = salientes.length;
  const jobsAntes = await contarJobs();
  const tEnvio = Date.now();

  const { body } = cuerpoTexto(clienteWa, "hola, tienen demo del bot?", wamid);
  const r1 = await ingestarComoProduccion(body);
  const r2 = await ingestarComoProduccion(body); // idéntico: mismo wamid

  console.log(`   ingesta 1: ACK ${ms(r1.ackMs)} · encolado=${r1.encolado}`);
  console.log(`   ingesta 2: ACK ${ms(r2.ackMs)} · encolado=${r2.encolado}  ${r2.encolado ? "⛔ DUPLICÓ" : "✅ deduplicado"}`);
  console.log(`   jobs nuevos en wa_jobs: ${(await contarJobs()) - jobsAntes} (debe ser 1)`);

  await esperarColaDrenada();
  const recibidos = salientes.slice(desde).filter((s) => s.to === clienteWa);
  console.log(`   el cliente recibió ${recibidos.length} mensaje(s) — debe ser 1:`);
  recibidos.forEach((s, i) => {
    console.log(`   ┌─ respuesta ${i + 1} [${s.tipo}] · +${seg(s.ts - tEnvio)}`);
    console.log(bloque(renderSaliente(s)));
    console.log(`   └─`);
  });
  const ok = !r2.encolado && recibidos.length === 1;
  resultados.push({
    caso: "7. Mensaje duplicado",
    ok,
    nota: ok ? "1 job, 1 respuesta" : `encolado2=${r2.encolado}, respuestas=${recibidos.length}`,
  });
}

// ── (7b) FASE C — la conversación de agenda COMPLETA (la ruta que genera plata) ──
// El caso 3 de la Fase A se quedó en "¿cómo te llamás?": sin terminar la conversación
// no sabemos si el bot llega a crear la cita, ni QUÉ horarios ofrece. Acá se completa
// el flujo por el camino de producción y se verifica contra la tabla wa_citas real.

const hoyCR = new Intl.DateTimeFormat("en-CA", {
  timeZone: tenant.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const ahoraCR = new Intl.DateTimeFormat("es-CR", {
  timeZone: tenant.timezone,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date());

async function citasEnDb(): Promise<any[]> {
  const r = await dbPg.execute(
    sql`SELECT cliente_wa, cliente_nombre, servicio_id, fecha, hora, estado, precio FROM wa_citas ORDER BY creada_en`,
  );
  return (r.rows ?? r) as any[];
}

if (corre("C.") || corre("agenda") || !filtro) {
  console.log(`\n${"━".repeat(78)}`);
  console.log(` FASE C — conversación de agenda completa (hoy es ${hoyCR}, son las ${ahoraCR} en ${tenant.timezone})`);
  console.log("━".repeat(78));

  // C1 — camino feliz: agendar HOY. Ojo con los horarios que ofrezca: el negocio abre
  // 08:00 y ya pasaron las 08:00/08:30, así que no deberían aparecer en la lista.
  console.log(`\nC1. Agendar para HOY (¿ofrece horas que ya pasaron?)`);
  const c1 = "50633330001";
  await turnoProduccion(c1, "Hola, quiero agendar una reunión de diagnóstico para hoy", "  (1)");
  await turnoProduccion(c1, "Me llamo Nathan Rosales", "  (2)");
  const ofrecidos = await turnoProduccion(c1, "sí, mostrame los horarios que tenés libres hoy", "  (3)");

  const lista = ofrecidos.find((s) => s.tipo === "interactive" && s.interactivo?.type === "list");
  if (lista) {
    const horas: string[] = (lista.interactivo.action?.sections?.[0]?.rows ?? []).map((f: any) => String(f.id));
    const pasados = horas.filter((id) => {
      const [, fecha, hora] = id.split("|");
      return fecha === hoyCR && hora < ahoraCR;
    });
    console.log(`   → ids ofrecidos: ${horas.join(", ")}`);
    if (pasados.length) {
      console.log(`   ⛔ OFRECE ${pasados.length} HORARIO(S) YA PASADO(S) (son las ${ahoraCR}): ${pasados.join(", ")}`);
      resultados.push({ caso: "C1. Horarios de hoy", ok: false, nota: `ofrece ${pasados.length} horas ya pasadas` });
    } else {
      console.log(`   ✅ ningún horario ofrecido es anterior a la hora actual`);
      resultados.push({ caso: "C1. Horarios de hoy", ok: true, nota: "sin horas pasadas" });
    }
  } else {
    console.log(`   👁  el bot no llegó a ofrecer una lista de horarios en 3 turnos`);
    resultados.push({ caso: "C1. Horarios de hoy", ok: "duda", nota: "no ofreció lista en 3 turnos" });
  }

  // C2 — fecha en el PASADO. El prompt lo prohíbe, pero agendar_cita no lo valida
  // (a diferencia de reprogramar_cita). Vemos si el guard existe de verdad.
  console.log(`\nC2. Pedir una cita para una fecha YA PASADA`);
  const c2 = "50633330002";
  await turnoProduccion(c2, "Buenas, soy Marta Jiménez y quiero una reunión de diagnóstico", "  (1)");
  await turnoProduccion(c2, "el 15 de julio a las 10 de la mañana, por favor", "  (2)");
  await turnoProduccion(c2, "sí, confirmá esa fecha: 15 de julio de este año a las 10am", "  (3)");

  const todas = await citasEnDb();
  const enPasado = todas.filter((c) => String(c.fecha) < hoyCR);
  console.log(`\n   citas creadas en wa_citas: ${todas.length}`);
  for (const c of todas) {
    const marca = String(c.fecha) < hoyCR ? "⛔ EN EL PASADO" : "✅";
    console.log(`     ${marca} ${c.fecha} ${c.hora} · ${c.servicio_id} · ${c.cliente_nombre} (${c.cliente_wa}) · precio=${c.precio ?? "—"}`);
  }
  if (enPasado.length) {
    resultados.push({ caso: "C2. Cita en el pasado", ok: false, nota: `${enPasado.length} cita(s) creada(s) con fecha pasada` });
  } else {
    resultados.push({ caso: "C2. Cita en el pasado", ok: true, nota: "el bot no creó ninguna cita pasada" });
  }

  // C3 — la pregunta que define la gravedad de C1: si el cliente TOCA uno de esos
  // horarios ya pasados, ¿se crea la cita? El tap llega como un mensaje `interactive`
  // con el id que nosotros emitimos (slot|fecha|hora) y lo procesa el agente.
  if (lista) {
    const horas: string[] = (lista.interactivo.action?.sections?.[0]?.rows ?? []).map((f: any) => String(f.id));
    const idPasado = horas.find((id) => {
      const [, fecha, hora] = id.split("|");
      return fecha === hoyCR && hora < ahoraCR;
    });
    if (idPasado) {
      const [, fechaP, horaP] = idPasado.split("|");
      console.log(`\nC3. El cliente TOCA el horario ya pasado (${horaP} de hoy, son las ${ahoraCR})`);
      const antes = (await citasEnDb()).length;
      const desde = salientes.length;
      const wamidTap = nuevoWamid();
      await ingestarComoProduccion({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: PNID },
                  messages: [
                    {
                      from: c1,
                      id: wamidTap,
                      type: "interactive",
                      interactive: { type: "list_reply", list_reply: { id: idPasado, title: horaP } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      await esperarColaDrenada();
      const rta = salientes.slice(desde).filter((s) => s.to === c1);
      for (const s of rta) {
        console.log(`      bot [${s.tipo}] ↓`);
        console.log(bloque(renderSaliente(s), "         "));
      }
      const despues = await citasEnDb();
      const creadaPasada = despues.find((c) => String(c.fecha) === fechaP && String(c.hora) === horaP);
      console.log(`   citas antes: ${antes} · después: ${despues.length}`);
      if (creadaPasada) {
        console.log(`   ⛔ SE CREÓ LA CITA EN UNA HORA YA PASADA: ${creadaPasada.fecha} ${creadaPasada.hora} · ${creadaPasada.cliente_nombre}`);
        resultados.push({ caso: "C3. Tap en hora pasada", ok: false, nota: `cita creada ${fechaP} ${horaP}` });
      } else {
        console.log(`   ✅ no se creó la cita en la hora pasada`);
        resultados.push({ caso: "C3. Tap en hora pasada", ok: true, nota: "rechazada" });
      }
    }
  }
}

// ── (8) Resumen ──

console.log(`\n${"═".repeat(78)}`);
console.log(" RESUMEN");
console.log("═".repeat(78));
for (const r of resultados) {
  const icono = r.ok === true ? "✅" : r.ok === false ? "⛔" : "👁 ";
  console.log(` ${icono} ${r.caso.padEnd(30)} ${r.nota}`);
}
console.log(`\n Llamadas reales a OpenAI (chat/completions): ${llamadasOpenAI}`);
console.log(` Mensajes interceptados hacia WhatsApp (nunca enviados): ${salientes.length}`);
console.log(" 👁  = requiere lectura humana de la respuesta de arriba.\n");

process.exit(0);
