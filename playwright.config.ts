import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./test/e2e-panel/constantes";

// ─────────────────────────────────────────────────────────────────────────────
// Config de Playwright para el E2E del panel (ángulo 6 de TESTING.md).
//
// webServer levanta el server de producción en modo memoria + Graph mockeado (ver
// test/e2e-panel/servidor.ts) — sin base de datos ni red. Requiere el build del panel
// (web/dist); `npm run test:e2e` lo construye antes.
//
// workers:1 / fullyParallel:false a propósito: TODAS las specs pegan al MISMO proceso
// con un repositorio EN MEMORIA compartido. Correrlas en paralelo haría que unas pisen
// el estado de otras (toggle de modo, citas creadas). En serie es determinista.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  testDir: "./test/e2e-panel",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: E2E.baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npx tsx test/e2e-panel/servidor.ts",
    url: `${E2E.baseURL}/salud`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
