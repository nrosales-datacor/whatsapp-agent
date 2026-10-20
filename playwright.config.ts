import { defineConfig, devices } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Config de Playwright. Dos proyectos:
//
//   • server (test/e2e/smoke.spec.ts): smoke del servidor nuevo — /health, la landing y el
//     panel compilado. Corre en modo test sobre un Postgres EFÍMERO en el proceso (PGlite
//     + las migraciones reales: sin DATABASE_URL) y en un puerto propio. Requiere el build
//     del panel (web/dist); `npm run test:e2e` lo construye antes.
//   • panel-mock (test/e2e/panel.spec.ts): el shell del panel (login, layout, rutas, menú
//     por rol y plan, superadmin) contra la API simulada (Vite en modo mock, sin backend).
//     Cuando la identidad real (I0.6) esté integrada, se suma un E2E contra el server.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PANEL_PORT = 5174;
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}`;

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
  },
  projects: [
    { name: "server", testMatch: /smoke\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: BASE_URL } },
    { name: "panel-mock", testMatch: /panel\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: PANEL_URL } },
  ],
  webServer: [
    {
      command: "npx tsx src/server.ts",
      url: `${BASE_URL}/health`,
      env: { PORT: String(PORT), DATABASE_URL: "", NODE_ENV: "test" },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000, // PGlite (WASM) + migraciones
      stdout: "pipe",
      stderr: "pipe",
    },
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
