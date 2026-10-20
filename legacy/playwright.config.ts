import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./test/e2e-panel/constantes";
import { E2E_DB } from "./test/e2e-db/constantes";

// ─────────────────────────────────────────────────────────────────────────────
// Config de Playwright para el E2E del panel (ángulo 6 de TESTING.md). Dos proyectos,
// cada uno contra su propio server de producción (src/server.ts) en modo test:
//
//   • "chromium" (test/e2e-panel): base local del server (PGlite en memoria) + SEED_DEMO
//     + Graph mockeado (test/e2e-panel/servidor.ts). Rápido, con el negocio de demo.
//   • "db" (test/e2e-db): Postgres EFÍMERO in-process (PGlite + migraciones reales)
//     + negocios/usuarios sembrados + toda la red mockeada (test/e2e-db/servidor.ts).
//     Cubre usuarios, "Mi negocio", campañas, superadmin, planes, cuotas y pausas.
//
// Ninguno toca la red ni la base de producción. Requieren el build del panel
// (web/dist); `npm run test:e2e` lo construye antes.
//
// workers:1 / fullyParallel:false a propósito: las specs de cada proyecto pegan al
// MISMO proceso con estado compartido (la base efímera de cada server). En serie es
// determinista.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  testDir: "./test",
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
    {
      name: "chromium",
      testDir: "./test/e2e-panel",
      use: { ...devices["Desktop Chrome"], baseURL: E2E.baseURL },
    },
    {
      name: "db",
      testDir: "./test/e2e-db",
      // La agenda pinta el "hoy" del navegador y el server valida contra la zona del
      // negocio: se fija la del negocio sembrado para que no dependa de la máquina.
      use: { ...devices["Desktop Chrome"], baseURL: E2E_DB.baseURL, timezoneId: "America/Costa_Rica", locale: "es-CR" },
    },
  ],
  webServer: [
    {
      command: "npx tsx test/e2e-panel/servidor.ts",
      url: `${E2E.baseURL}/salud`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000, // PGlite (WASM) + migraciones + seed de demo
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npx tsx test/e2e-db/servidor.ts",
      url: `${E2E_DB.baseURL}/salud`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
