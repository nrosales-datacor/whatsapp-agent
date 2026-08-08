import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { E2E } from "./constantes";

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint del servidor para el E2E del panel (ángulo 6 de TESTING.md). Lo lanza
// Playwright (ver playwright.config.ts → webServer). Levanta el MISMO server de
// producción (src/server.ts) pero en modo seguro para tests:
//
//   • SIN base de datos → repositorio EN MEMORIA (RepositorioEnMemoria). Jamás toca
//     Postgres ni el .env real (ver el truco de DOTENV_CONFIG_PATH abajo).
//   • SEED_DEMO=1 → siembra conversaciones y citas de demo en memoria.
//   • Graph API mockeado in-process (mismo helper que el E2E del webhook, ángulo 3):
//     responder() "envía" al cliente sin salir a la red.
//
// Todo esto se configura ANTES de importar src/server.ts, porque ese módulo lee el
// entorno y construye clientes (OpenAI, tenantStore) en el load.
// ─────────────────────────────────────────────────────────────────────────────

// (1) Evitar cargar el .env REAL. src/server.ts hace `import "dotenv/config"`, que sin
// esto poblaría DATABASE_URL con la base de producción → el server escribiría en
// Supabase. Apuntamos dotenv a un archivo inexistente (no carga nada) y borramos la
// var por si el shell ya la tenía. NUNCA se toca producción (principio 2 de TESTING.md).
process.env.DOTENV_CONFIG_PATH = "test/e2e-panel/.env.inexistente";
delete process.env.DATABASE_URL;

process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "1";
process.env.PORT = String(E2E.puerto);
process.env.PANEL_SESSION_SECRET = E2E.secret; // conocido → las specs pueden mintear cookies
// E6/BLOQUEANTE-10: el rate limit de login es por IP, y TODO el suite de Playwright
// pega desde la misma IP (localhost) contra el MISMO proceso servidor (un solo worker,
// ver constantes.ts). Varios specs hacen login legítimo repetidas veces (uno por test) +
// algún login fallido a propósito — sin este override, el default de producción (10
// intentos/5min) se agotaría a mitad del suite y tests correctos empezarían a fallar
// con 429. Subimos el tope solo acá; el default real de producción no cambia.
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "1000";
// enviarTexto exige un access token; el mock de Graph (paso 3) intercepta el POST, así
// que este token dummy nunca viaja a la red.
process.env.WHATSAPP_ACCESS_TOKEN = "e2e-token-dummy";

// (2) El panel se sirve del build de Vite (web/dist). Si no está, /panel devuelve 503
// y los tests fallarían de forma confusa: cortamos temprano con un mensaje claro.
const indexDist = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));
if (!existsSync(indexDist)) {
  console.error(
    "❌ Falta el build del panel (web/dist/index.html).\n" +
      "   Corré `npm run web:build` antes del E2E (o usá `npm run test:e2e`, que lo hace).",
  );
  process.exit(1);
}

// (3) El hash del password del panel se computa acá (salt aleatorio por arranque): así el
// login del operador funciona en memoria sin commitear ningún hash. auth.ts lee
// PANEL_SESSION_SECRET en el load, por eso se setea arriba antes de importarlo.
const { hashearPassword } = await import("../../src/panel/auth");
process.env.PANEL_PASSWORD_HASH_SELYON = await hashearPassword(E2E.password);

// (4) Instala el dispatcher de fetch mockeado (Graph API) ANTES de importar el server:
// src/server.ts → handleWebhook → whatsapp/transcribir.ts construye `new OpenAI()` en el
// load (que exige OPENAI_API_KEY, seteada por el mock), y responder() postea a Graph.
const { instalarMockWebhook } = await import("../helpers/webhookMock");
instalarMockWebhook();

// (5) Importar el server arranca todo (top-level await: carga tenants, siembra demo, listen).
await import("../../src/server");
