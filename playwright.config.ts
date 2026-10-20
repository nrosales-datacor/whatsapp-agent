import { defineConfig, devices } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Config de Playwright. Por ahora un smoke del servidor nuevo (test/e2e): /health, la
// landing y el panel compilado. El E2E del panel se rehace en I0.7 con el shell nuevo
// (login, layout, rutas).
//
// El server corre en modo test sobre un Postgres EFÍMERO en el proceso (PGlite + las
// migraciones reales: sin DATABASE_URL) y en un puerto propio. Requiere el build del
// panel (web/dist); `npm run test:e2e` lo construye antes.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: BASE_URL } }],
  webServer: {
    command: "npx tsx src/server.ts",
    url: `${BASE_URL}/health`,
    env: { PORT: String(PORT), DATABASE_URL: "", NODE_ENV: "test" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // PGlite (WASM) + migraciones
    stdout: "pipe",
    stderr: "pipe",
  },
});
