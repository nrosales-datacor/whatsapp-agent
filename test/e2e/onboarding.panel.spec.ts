import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de los primeros pasos del Inicio (I6) contra la API simulada (proyecto "panel-mock"):
// un negocio recién dado de alta los ve, cada paso se marca solo al guardar lo que
// corresponde, se pueden ocultar, y los negocios ya configurados no los muestran. Datos:
// web/src/lib/mockApi.ts.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Alta self-service de un negocio Pro, confirmación del correo e ingreso. */
async function newBusiness(page: Page) {
  await page.goto("/panel/signup");
  await page.getByLabel("Nombre del negocio").fill("Consultorio Brisa");
  await page.getByLabel("Rubro").selectOption("dental");
  await page.getByLabel("Plan").selectOption("pro");
  await page.getByLabel("Tu nombre").fill("Elena Mora");
  await page.getByLabel("Correo", { exact: true }).fill("elena@brisa.test");
  await page.getByLabel("Clave", { exact: true }).fill("clave-de-elena");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Revisá tu correo" })).toBeVisible();
  await page.goto("/panel/verify-email?token=confirmar");
  await expect(page.getByRole("heading", { level: 1, name: "¡Correo confirmado!" })).toBeVisible();
  await login(page, "elena@brisa.test", "clave-de-elena");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("primeros pasos: un negocio nuevo los ve en el Inicio, se marcan solos y se pueden ocultar", async ({ page }) => {
  await newBusiness(page);
  const card = page.getByRole("region", { name: "Primeros pasos" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("0 de 5 listos");
  await expect(card.getByRole("progressbar", { name: "Primeros pasos" })).toHaveAttribute("aria-valuenow", "0");

  // Guardar el horario marca el primer paso.
  await card.getByRole("link", { name: "Ver horario" }).click();
  await expect(page).toHaveURL(/\/panel\/settings\/locations$/);
  await page.getByRole("button", { name: "Horario de Principal" }).click();
  const dialog = page.getByRole("dialog", { name: "Horario de Principal" });
  await dialog.getByRole("button", { name: "Guardar horario" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("link", { name: "Inicio" }).first().click();
  await expect(card).toContainText("1 de 5 listos");
  await expect(card.getByRole("link", { name: "Ver horario" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Ver servicios" })).toBeVisible();

  // Ocultarla: se va y no vuelve.
  await card.getByRole("button", { name: "Ocultar" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toHaveCount(0);
});

test("primeros pasos: un negocio ya configurado no los muestra", async ({ page }) => {
  await login(page, "duena@demo.test");
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toHaveCount(0);
});

test("móvil: los primeros pasos sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await newBusiness(page);
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
