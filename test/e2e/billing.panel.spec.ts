import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del cobro en línea (I6) contra la API simulada (proyecto "panel-mock"). Stripe no
// existe en el mock: "Suscribirme" y "Gestionar pago" simulan lo que harían Stripe y su
// webhook y vuelven a Configuración › Plan. El estado vive en sessionStorage.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";
const TOTP_CODE = "123456";

const heading = (page: Page, name: string, level = 1) => page.getByRole("heading", { level, name, exact: true });

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test("prueba: el aviso cuenta los días; suscribirse al Pro vuelve con el plan nuevo y Gestionar pago", async ({ page }) => {
  test.slow(); // sale a "Stripe" y vuelve con una recarga completa
  await login(page, "prueba@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  const banner = page.getByRole("status").filter({ hasText: "Te quedan 9 días de prueba gratis" });
  await expect(banner).toBeVisible();
  await banner.getByRole("link", { name: "Suscribirme" }).click();

  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);
  const card = page.getByRole("region", { name: "Suscripción" });
  await expect(card).toContainText("Te quedan 9 días de prueba gratis");
  await expect(card).toContainText("no te cobramos nada hasta que termine la prueba");
  await expect(page.locator(".billing-banner"), "en Plan no se repite el aviso").toHaveCount(0);

  await card.getByLabel("Sucursales extra").fill("1");
  await card.getByRole("button", { name: "Suscribirme al Pro" }).click();
  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);
  await expect(card).toContainText("Stripe nos está confirmando el pago");
  await expect(page.getByRole("region", { name: "Plan actual" })).toContainText("Pro");
  await expect(card.getByRole("button", { name: "Gestionar pago" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Suscribirme al Pro" })).toHaveCount(0);

  // Con la suscripción viva ya no se muestra el aviso de la prueba.
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Inicio", exact: true }).click();
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(page.getByText("Te quedan 9 días de prueba gratis")).toHaveCount(0);
});

test("pago atrasado: aviso con la fecha de pausa; Gestionar pago lo deja al día", async ({ page }) => {
  await login(page, "atrasada@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  const banner = page.getByRole("alert").filter({ hasText: "No pudimos cobrar tu suscripción" });
  await expect(banner).toContainText("para que la cuenta no se pause");
  await banner.getByRole("button", { name: "Gestionar pago" }).click();

  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);
  await expect(page.getByRole("region", { name: "Plan actual" })).toContainText("Al día");
  await expect(page.getByRole("region", { name: "Suscripción" })).toContainText("Tu suscripción se renueva el");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Inicio", exact: true }).click();
  await expect(page.getByText("No pudimos cobrar tu suscripción")).toHaveCount(0);
});

test("pausada por el cobro: entra solo a pagar y, al suscribirse, la cuenta vuelve", async ({ page }) => {
  await login(page, "pagopausado@demo.test");
  await expect(heading(page, "Cuenta pausada")).toBeVisible();
  const reactivate = page.getByRole("region", { name: "Reactivá tu cuenta" });
  await expect(reactivate).toContainText("Tu suscripción terminó.");
  await reactivate.getByRole("button", { name: "Suscribirme al Básico" }).click();

  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Plan actual" })).toContainText("Al día");
});

test("pausa del superadmin: el login lo explica y no ofrece pagar", async ({ page }) => {
  await login(page, "pausada@demo.test");
  await expect(page.getByRole("alert").filter({ hasText: "pausada" })).toBeVisible();
  await expect(page).toHaveURL(/\/panel\/login$/);
  await expect(page.getByRole("region", { name: "Reactivá tu cuenta" })).toHaveCount(0);
});

test("cobro manual en prueba sin vencimiento: sin aviso; en Plan, la dueña puede suscribirse", async ({ page }) => {
  await login(page, "basico@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(page.locator(".billing-banner")).toHaveCount(0);
  await page.goto("/panel/settings/plan");
  const card = page.getByRole("region", { name: "Suscripción" });
  await expect(card.getByRole("button", { name: "Suscribirme al Básico" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Suscribirme al Pro" })).toBeVisible();
});

test("superadmin: ve el cobro en línea del negocio (Stripe)", async ({ page }) => {
  await page.goto("/panel/admin/login");
  await page.getByLabel("Usuario", { exact: true }).fill("admin");
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByLabel("Código", { exact: true }).fill(TOTP_CODE);
  await page.getByRole("button", { name: "Verificar y entrar" }).click();
  await expect(heading(page, "Negocios")).toBeVisible();

  await page.getByRole("listitem").filter({ hasText: "Peluquería Norte" }).getByRole("link").first().click();
  const stripe = page.getByRole("region", { name: "Cobro en línea (Stripe)" });
  await expect(stripe).toContainText("Pago atrasado");
  await expect(stripe).toContainText("Se pausa el");
  await expect(stripe.getByRole("link", { name: /cus_demo_/ })).toHaveAttribute("href", /dashboard\.stripe\.com\/test\/customers\//);
});
