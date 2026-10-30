import { defineConfig, devices } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Config de Playwright. Dos proyectos:
//
//   • server (test/e2e/smoke.spec.ts): smoke del servidor REAL — /health, router, sesión,
//     login (falso → 401 y uno de verdad por la UI hasta el Inicio), la landing y el panel
//     compilado. Corre en modo test sobre un Postgres EFÍMERO en el proceso (PGlite + las
//     migraciones reales: sin DATABASE_URL) sembrado con scripts/seedDev.ts por
//     test/e2e/seededServer.ts, en un puerto propio. Requiere el build del panel (web/dist);
//     `npm run test:e2e` lo construye antes.
//   • panel-mock (test/e2e/*panel.spec.ts): el panel (login, layout, rutas, menú por rol y
//     plan, superadmin y cada sección) contra la API simulada (Vite en modo mock, sin backend).
// ─────────────────────────────────────────────────────────────────────────────

// Puertos configurables (E2E_SERVER_PORT / E2E_PANEL_PORT) para correr en paralelo desde
// varios worktrees sin reusar el server de otro. E2E_PANEL_ONLY=1 no levanta el backend
// (alcanza para el proyecto panel-mock).
const PORT = Number(process.env.E2E_SERVER_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PANEL_PORT = Number(process.env.E2E_PANEL_PORT) || 5174;
const PANEL_ONLY = process.env.E2E_PANEL_ONLY === "1";
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}`;
// Solo local: un Chromium ya instalado que no es la revisión que trae @playwright/test (p. ej.
// un contenedor con navegadores preinstalados). En CI no se define y se usa el de
// `npx playwright install`.
const CHROMIUM_PATH = process.env.E2E_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "on-first-retry",
    ...(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: "server", testMatch: /smoke\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: BASE_URL } },
    { name: "panel-mock", testMatch: /panel\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: PANEL_URL } },
  ],
  webServer: [
    ...(PANEL_ONLY ? [] : [{
      // Siembra una base PGlite nueva (carpeta temporal) y levanta src/server.ts sobre ella.
      command: "npx tsx test/e2e/seededServer.ts",
      url: `${BASE_URL}/health`,
      env: { PORT: String(PORT), DATABASE_URL: "", NODE_ENV: "test" },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000, // PGlite (WASM) + migraciones + seed
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    }]),
    {
      // Vite en modo mock (web/.env.mock): el panel responde con lib/mockApi.ts.
      command: `npm --prefix web run dev:mock -- --port ${PANEL_PORT} --strictPort --host 127.0.0.1`,
      url: `${PANEL_URL}/panel/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
