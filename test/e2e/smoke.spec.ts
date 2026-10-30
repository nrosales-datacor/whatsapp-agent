import { expect, test } from "@playwright/test";
import { DEMO_OWNER_EMAIL, DEMO_PASSWORD } from "../../scripts/seedDev";

// ─────────────────────────────────────────────────────────────────────────────
// Smoke del servidor REAL (proyecto "server" de playwright.config.ts): el proceso arranca
// sobre una base PGlite efímera con las migraciones reales y el seed de desarrollo
// (test/e2e/seededServer.ts). Cubre lo que el smoke post-deploy (scripts/ci/smoke.sh) no
// puede probar en producción: un login de verdad que llega al Inicio con datos de la base.
//
// Cada test falla si se rompe una capa distinta: /health (proceso + ping a la base),
// router de la API (404 JSON), sesión (401 en /auth/me), CSRF + validación + base (401
// `invalid_credentials` en el login falso; un 500 delata la base) y el panel compilado
// contra el backend (login por la UI → Inicio).
// ─────────────────────────────────────────────────────────────────────────────

/** Correo del login falso: dominio reservado `.invalid` (RFC 2606), reconocible en logs. */
const SMOKE_EMAIL = "smoke-test@selyon-smoke.invalid";

test("/health responde 200 con el ping a la base", async ({ request }) => {
  const r = await request.get("/health");
  expect(r.status()).toBe(200);
  expect(await r.text()).toMatch(/: ok$/);
});

test("una ruta desconocida bajo /api/panel/ responde 404 JSON (el router está montado)", async ({ request }) => {
  const r = await request.get("/api/panel/smoke-route-that-does-not-exist");
  expect(r.status()).toBe(404);
  expect(r.headers()["content-type"]).toMatch(/application\/json/);
  expect(await r.json()).toMatchObject({ ok: false, code: "not_found" });
});

test("GET /api/panel/auth/me sin cookie responde 401 unauthorized (la sesión se valida)", async ({ request }) => {
  const r = await request.get("/api/panel/auth/me");
  expect(r.status()).toBe(401);
  expect(r.headers()["content-type"]).toMatch(/application\/json/);
  expect(await r.json()).toMatchObject({ ok: false, code: "unauthorized" });
});

test("POST /api/panel/auth/login con credenciales inexistentes responde 401 invalid_credentials", async ({ request, baseURL }) => {
  // Origin del mismo host: pasa el CSRF; el cuerpo pasa Zod; la búsqueda del usuario va a la base.
  const r = await request.post("/api/panel/auth/login", {
    headers: { origin: baseURL! },
    data: { email: SMOKE_EMAIL, password: "smoke-not-a-real-password" },
  });
  expect(r.status()).toBe(401);
  expect(await r.json()).toMatchObject({ ok: false, code: "invalid_credentials" });
});

test("/panel sirve el bundle de React (#root)", async ({ page }) => {
  const r = await page.goto("/panel");
  expect(r?.status()).toBe(200);
  await expect(page.locator("#root")).toHaveCount(1);
});

test("la landing carga en /", async ({ page }) => {
  const r = await page.goto("/");
  expect(r?.status()).toBe(200);
  await expect(page.locator("body")).not.toBeEmpty();
});

test("login real por la UI del panel contra la base sembrada → Inicio con datos", async ({ page }) => {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(DEMO_OWNER_EMAIL);
  await page.getByLabel("Clave", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await expect(page).toHaveURL(/\/panel\/?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Inicio", exact: true })).toBeVisible();
  // La tarjeta del día sale de GET /api/panel/home/today (si la API falla, el Inicio muestra el error).
  await expect(page.getByRole("heading", { level: 2, name: /de hoy$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver agenda" })).toBeVisible();

  // La cookie de sesión que dejó el login vale contra el backend real.
  const me = await page.request.get("/api/panel/auth/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ ok: true, data: { business: { name: "Estética Demo" } } });
});
