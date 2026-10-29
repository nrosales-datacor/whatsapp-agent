import { expect, test } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Smoke del servidor nuevo: el proceso arranca sobre la base efímera, /health responde,
// la landing carga y /panel sirve el bundle de React. El E2E completo del panel se rehace
// en I0.7.
// ─────────────────────────────────────────────────────────────────────────────

test("/health responde 200 con el ping a la base", async ({ request }) => {
  const r = await request.get("/health");
  expect(r.status()).toBe(200);
  expect(await r.text()).toMatch(/: ok$/);
});

test("la API responde JSON aunque todavía no tenga rutas (404 { ok: false })", async ({ request }) => {
  const r = await request.get("/api/panel/me");
  expect(r.status()).toBe(404);
  expect(await r.json()).toMatchObject({ ok: false });
});

test("la landing carga en /", async ({ page }) => {
  const r = await page.goto("/");
  expect(r?.status()).toBe(200);
  await expect(page.locator("body")).not.toBeEmpty();
});

test("/panel sirve el bundle de React (#root)", async ({ page }) => {
  const r = await page.goto("/panel");
  expect(r?.status()).toBe(200);
  await expect(page.locator("#root")).toHaveCount(1);
});
