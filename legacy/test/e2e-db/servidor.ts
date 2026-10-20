import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { E2E_DB, TENANTS, USUARIOS } from "./constantes";

// ─────────────────────────────────────────────────────────────────────────────
// Servidor E2E CON BASE DE DATOS (complemento del ángulo 6 de TESTING.md). Lo lanza
// Playwright (playwright.config.ts → webServer del proyecto "db"). Levanta el MISMO
// src/server.ts de producción, pero:
//
//   • Con un Postgres EFÍMERO in-process (PGlite + migraciones reales de ./drizzle),
//     inyectado con `_inyectarDbParaTests`: DATABASE_URL apunta a un host inválido que
//     NUNCA se usa (obtenerDb() devuelve el PGlite). Jamás toca Supabase.
//   • Con negocios/usuarios sembrados que cubren cada estado del panel (Pro, Básico al
//     80% y al 100% de cuota, tope de IA agotado, pausado) + los datos de demo.
//   • Con TODA la red mockeada (Graph API, OAuth de Embedded Signup, OpenAI) por un
//     fetch propio, y un servidor de CONTROL (puertoControl) para que las specs lean qué
//     "envió" el bot y fuercen fallas de Graph.
//
// Así se ejerce lo que en memoria responde 503: usuarios, "Mi negocio", campañas,
// superadmin (alta, plan, pausa, WhatsApp, reset de clave, borrado, historial).
// ─────────────────────────────────────────────────────────────────────────────

// (1) Entorno ANTES de importar cualquier módulo del server (leen el entorno en el load).
process.env.DOTENV_CONFIG_PATH = "test/e2e-db/.env.inexistente"; // nunca cargar el .env real
process.env.DATABASE_URL = "postgres://pglite-e2e.invalid:5432/e2e"; // solo activa el modo "con base"
delete process.env.SEED_DEMO; // con DATABASE_URL se ignora igual; se siembra a mano abajo
process.env.NODE_ENV = "test";
process.env.PORT = String(E2E_DB.puerto);
process.env.PANEL_SESSION_SECRET = E2E_DB.secret;
process.env.TOKENS_ENCRYPTION_KEY = E2E_DB.tokensKey;
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "1000"; // toda la suite pega desde localhost
process.env.OPENAI_API_KEY = "sk-e2e-dummy"; // el fetch mockeado intercepta OpenAI
process.env.WHATSAPP_APP_SECRET = E2E_DB.appSecret; // firma del webhook simulado
process.env.WHATSAPP_VERIFY_TOKEN = E2E_DB.verifyToken;
process.env.META_APP_ID = "111111111111111"; // Embedded Signup "configurado" (SDK mockeado en el navegador)
process.env.META_ES_CONFIG_ID = "222222222222222";
process.env.PANEL_SUPERADMIN_USUARIO = E2E_DB.superadmin.usuario;
process.env.PANEL_SUPERADMIN_TOTP_SECRET = E2E_DB.totpSecret;
process.env.PLATAFORMA_CONTACTO_WHATSAPP = E2E_DB.contactoWhatsapp;
process.env.QUEUE_POLL_MS = "250"; // el worker toma rápido los mensajes del webhook simulado
process.env.CAMPANIA_POLL_MS = "300";
process.env.CAMPANIA_ENVIO_INTERVALO_MS = "20";
delete process.env.WHATSAPP_ACCESS_TOKEN; // cada negocio usa su propio token (cifrado en la base)
delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
delete process.env.GOOGLE_PLACES_API_KEY;
delete process.env.SENTRY_DSN;
delete process.env.ALERTAS_WEBHOOK_URL;

const indexDist = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));
if (!existsSync(indexDist)) {
  console.error("❌ Falta el build del panel (web/dist/index.html). Corré `npm run web:build`.");
  process.exit(1);
}

// Llaves VAPID efímeras: la campana de notificaciones solo aparece si el server tiene push.
const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = "mailto:e2e@selyon.test";

const { hashearPassword } = await import("../../src/panel/auth");
process.env.PANEL_SUPERADMIN_HASH = await hashearPassword(E2E_DB.superadmin.password);

// (2) Red mockeada. El SDK de OpenAI captura globalThis.fetch al construirse, así que el
// dispatcher se instala ANTES de importar el server y consulta un estado mutable.
interface Enviado {
  tipo: string;
  to: string;
  texto?: string;
  plantilla?: string;
  phoneNumberId: string;
  raw: unknown;
}
const estadoRed = { enviados: [] as Enviado[], graphFalla: false, llamadasLLM: 0, pushes: 0 };
const fetchOriginal = globalThis.fetch;

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url);
  const metodo = String(init?.method ?? "GET").toUpperCase();

  if (url.includes("api.openai.com") && url.includes("/chat/completions")) {
    estadoRed.llamadasLLM++;
    return jsonRes({
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "Respuesta automática del bot (E2E)." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  if (url.includes("graph.facebook.com")) {
    if (url.includes("/oauth/access_token")) return jsonRes({ access_token: "EAAe2eEmbeddedSignupToken123456" });
    if (url.includes("/subscribed_apps")) return jsonRes({ success: true });
    if (url.includes("/register")) return jsonRes({ success: true });
    if (url.includes("/messages") && metodo === "POST") {
      if (estadoRed.graphFalla) {
        return jsonRes({ error: { message: "(#131047) Re-engagement message (E2E)", type: "OAuthException", code: 131047 } }, 400);
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const pnid = /graph\.facebook\.com\/[^/]+\/([^/]+)\/messages/.exec(url)?.[1] ?? "";
      estadoRed.enviados.push({
        tipo: String(body.type ?? "?"),
        to: String(body.to ?? ""),
        texto: body.type === "text" ? body.text?.body : undefined,
        plantilla: body.type === "template" ? body.template?.name : undefined,
        phoneNumberId: pnid,
        raw: body,
      });
      return jsonRes({ messages: [{ id: `wamid.e2e.${estadoRed.enviados.length}` }] });
    }
    return jsonRes({ url: "https://media.e2e/archivo.jpg", mime_type: "image/jpeg" });
  }
  // Web Push (si el navegador llegó a suscribirse): se acepta sin salir a la red.
  if (/fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com/.test(url)) {
    estadoRed.pushes++;
    return new Response(null, { status: 201 });
  }
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) return fetchOriginal(input, init);
  console.error(`[e2e-db] fetch NO mockeado (bloqueado): ${metodo} ${url}`);
  throw new Error(`e2e-db: red bloqueada (${url})`);
}) as typeof fetch;

// Servidor de control para las specs (lo que el bot envió, forzar fallas de Graph).
http
  .createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://control");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/enviados") return res.end(JSON.stringify(estadoRed.enviados));
    if (u.pathname === "/estado") return res.end(JSON.stringify({ llamadasLLM: estadoRed.llamadasLLM, pushes: estadoRed.pushes }));
    if (u.pathname === "/graph") {
      estadoRed.graphFalla = u.searchParams.get("fallar") === "1";
      return res.end(JSON.stringify({ ok: true, graphFalla: estadoRed.graphFalla }));
    }
    res.statusCode = 404;
    res.end("{}");
  })
  .listen(E2E_DB.puertoControl);

// (3) Base efímera con las migraciones reales, inyectada como el pool del proceso.
const { crearDbEfimera } = await import("../helpers/pgliteDb");
const { db } = await crearDbEfimera();
const { _inyectarDbParaTests } = await import("../../src/db/client");
_inyectarDbParaTests(db);

// (4) Siembra: negocios + usuarios. `cargarTenants` primero (activa el modo con base;
// con la base vacía cae al fallback y lo avisa por consola, es esperado).
const store = await import("../../src/config/tenantStore");
const { TENANT_FALLBACK_SELYON } = await import("../../src/config/tenants");
const schemaMod = await import("../../src/db/schema");
const { anioMesActual } = await import("../../src/observabilidad/uso");
const { sql, eq, and } = await import("drizzle-orm");
await store.cargarTenants();

const TODOS_LOS_DIAS = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, { abre: "08:00", cierra: "18:00" }]));
const SIN_DOMINGO = { ...TODOS_LOS_DIAS, 0: { abre: null, cierra: null } };

// Mismo catálogo que el negocio de la demo (src/panel/seedDemo.ts), pero con ids VÁLIDOS
// para el validador de "Mi negocio" (RE_SLUG: guiones, no guiones bajos). Las citas de la
// demo usan "limpieza_dental": tras sembrarlas se traducen abajo ("_" → "-").
const SERVICIOS_CLINICA = [
  { id: "limpieza-dental", nombre: "Limpieza dental", precio: 25000, duracionMin: 45, agendable: true, descripcion: "Remoción de sarro.", addonSugeridoId: "fluor", addonPrecioPromo: 8000, addonActivo: true },
  { id: "valoracion", nombre: "Valoración", precio: 15000, duracionMin: 30, agendable: true },
  { id: "resina", nombre: "Resina (calza estética)", precio: 35000, duracionMin: 40, agendable: true },
  { id: "blanqueamiento", nombre: "Blanqueamiento", precio: 120000, duracionMin: 60, agendable: true },
  { id: "extraccion", nombre: "Extracción de muela del juicio", precio: 85000, duracionMin: 60, agendable: true },
  { id: "fluor", nombre: "Aplicación de flúor", precio: 8000, duracionMin: 15 },
];

function tenantBase(t: { id: string; nombre: string; pnid: string }, plan: "basico" | "pro", extra: Record<string, unknown> = {}) {
  return {
    ...TENANT_FALLBACK_SELYON,
    id: t.id,
    nombre: t.nombre,
    phoneNumberId: t.pnid,
    accessToken: `EAAe2e${t.id}Token1234567890`,
    panelPasswordHash: undefined,
    horario: TODOS_LOS_DIAS,
    bloqueos: [],
    empleados: [],
    plan,
    ...extra,
  } as typeof TENANT_FALLBACK_SELYON;
}

const altas: [ReturnType<typeof tenantBase>, (typeof USUARIOS)[keyof typeof USUARIOS]][] = [
  [
    tenantBase(TENANTS.clinica, "pro", {
      tipoNegocio: "una clínica dental",
      ubicacion: "San José, Costa Rica",
      servicios: SERVICIOS_CLINICA,
      linkResenas: "https://g.page/r/clinica-e2e",
    }),
    USUARIOS.clinica,
  ],
  [tenantBase(TENANTS.basico, "basico", { horario: SIN_DOMINGO }), USUARIOS.basico],
  [tenantBase(TENANTS.lleno, "basico"), USUARIOS.lleno],
  [tenantBase(TENANTS.gastoia, "basico"), USUARIOS.gastoia],
  [tenantBase(TENANTS.pausado, "basico"), USUARIOS.pausado],
];
for (const [tenant, u] of altas) {
  await store.crearTenant(tenant, { usuario: u.usuario, passwordHash: await hashearPassword(u.password) });
}
for (const u of [USUARIOS.clinicaOp, USUARIOS.clinicaReset, USUARIOS.llenoOp]) {
  await store.crearUsuarioTenant(u.tenantId, { usuario: u.usuario, passwordHash: await hashearPassword(u.password), rol: u.rol });
}

// Uso del mes: Básico al 85% (425/500), Lleno al 100% (500/500), Gasto IA con USD 16 de 15.
const mes = anioMesActual();
await db.insert(schemaMod.waUsoMensual).values([
  { tenantId: TENANTS.basico.id, anioMes: mes, conversacionesIniciadas: 425 },
  { tenantId: TENANTS.lleno.id, anioMes: mes, conversacionesIniciadas: 500 },
  { tenantId: TENANTS.gastoia.id, anioMes: mes, conversacionesIniciadas: 3, costoEstimadoMillonesimos: 16_000_000 },
]);

await store.cambiarEstadoTenant(TENANTS.pausado.id, false, "e2e-seed", "Falta de pago (E2E)");
await store.recargar();

// (5) Datos de demo (bandeja, agenda, métricas) para la clínica, por el repo REAL
// (RepositorioDrizzle). seedDemo siembra en listarTenants()[0]: se verifica que sea ella.
const primero = store.listarTenants()[0]?.id;
if (primero !== TENANTS.clinica.id) {
  console.error(`❌ [e2e-db] seedDemo sembraría en "${primero}", no en "${TENANTS.clinica.id}". Revisá el orden del seed.`);
  process.exit(1);
}
const { RepositorioDrizzle } = await import("../../src/booking/drizzleRepository");
const repo = new RepositorioDrizzle(db);
const { seedDemo } = await import("../../src/panel/seedDemo");
await seedDemo(repo);

await db.execute(sql`UPDATE wa_citas SET servicio_id = replace(servicio_id, '_', '-') WHERE tenant_id = ${TENANTS.clinica.id}`);
await db.execute(sql`UPDATE wa_cotizaciones SET servicio_id = replace(servicio_id, '_', '-') WHERE tenant_id = ${TENANTS.clinica.id}`);

// RepositorioDrizzle ignora `creadoEn` (la base pone now()): sin esto TODAS las
// conversaciones de la demo tendrían la ventana de 24h abierta. Se envejecen las que la
// demo pinta como "de hace más de un día" (Pedro, Sofía, Fernando).
await db.execute(
  sql`UPDATE wa_mensajes SET creado_en = now() - interval '30 hours' WHERE conversacion_id IN (SELECT id FROM wa_conversaciones WHERE tenant_id = ${TENANTS.clinica.id} AND cliente_wa IN ('50684556677', '50687665544', '50661334477'))`,
);

// Extras sobre la demo: un cliente con permiso de promociones (destinatario de campañas)
// y una cita de HOY "sin confirmar" (ya recibió el recordatorio del mismo día).
const wc = schemaMod.waConversaciones;
await db
  .update(wc)
  .set({ marketingConsentimientoEn: new Date() })
  .where(and(eq(wc.tenantId, TENANTS.clinica.id), eq(wc.clienteWa, "50687123344")));
await db.execute(
  sql`UPDATE wa_citas SET recordatorio_mismo_dia_en = now() WHERE tenant_id = ${TENANTS.clinica.id} AND cliente_nombre = 'Marcela Ríos' AND estado = 'agendada' AND confirmada_en IS NULL AND fecha = (SELECT min(fecha) FROM wa_citas WHERE tenant_id = ${TENANTS.clinica.id} AND cliente_nombre = 'Marcela Ríos' AND fecha >= to_char(now() AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD'))`,
);

// (6) Arranca el server de producción (carga los tenants de la base y escucha).
await import("../../src/server");
console.log(`[e2e-db] listo: panel en ${E2E_DB.baseURL}/panel · control en ${E2E_DB.controlURL}`);
