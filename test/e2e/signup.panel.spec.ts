import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del alta self-service y los primeros pasos (I6) contra la API simulada (proyecto
// "panel-mock"). En modo demo no hay correo: la pantalla "Revisá tu correo" muestra el
// enlace de verificación. El estado del mock vive en sessionStorage: cada test arranca limpio.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

const heading = (page: Page, name: string, level = 1) => page.getByRole("heading", { level, name, exact: true });

async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

async function fillSignup(page: Page, data: { business: string; name: string; email: string; password?: string; industry?: string }) {
  await page.goto("/panel/signup");
  await expect(heading(page, "Probá Selyon CRM gratis")).toBeVisible();
  await page.getByLabel("Nombre del negocio").fill(data.business);
  if (data.industry) await page.getByLabel("Rubro").selectOption(data.industry);
  await page.getByLabel("Tu nombre").fill(data.name);
  await page.getByLabel("Tu correo").fill(data.email);
  await page.getByLabel("Clave", { exact: true }).fill(data.password ?? "clave-segura-1");
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
}

test("alta: formulario → revisá tu correo → enlace → Inicio con primeros pasos y la prueba de 14 días", async ({ page }) => {
  test.slow(); // recorre el alta entera
  await page.goto("/panel/login");
  await page.getByRole("link", { name: "¿Primera vez? Creá tu cuenta gratis" }).click();
  await expect(page).toHaveURL(/\/panel\/signup$/);
  await expect(page.getByText("14 días gratis, sin tarjeta.")).toBeVisible();

  // El país propone su zona y su moneda.
  await page.getByLabel("País").selectOption("PA");
  await expect(page.getByLabel("Moneda")).toHaveValue("USD");
  await expect(page.getByLabel("Zona horaria")).toHaveValue("America/Panama");
  await page.getByLabel("País").selectOption("CR");

  await fillSignup(page, { business: "Estudio Lumen", name: "Laura Méndez", email: "laura@lumen.cr", industry: "generic" });
  await expect(heading(page, "Revisá tu correo")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "laura@lumen.cr" })).toContainText("14 días de prueba");

  await page.getByRole("link", { name: "Confirmar mi correo" }).click();
  await expect(heading(page, "Inicio")).toBeVisible();
  const steps = page.getByRole("region", { name: "Primeros pasos" });
  await expect(steps).toContainText("0 de 5 listos");
  await expect(steps.getByRole("listitem")).toHaveCount(5);
  await expect(steps).toContainText("Conectá tu WhatsApp");
  await expect(page.getByRole("status").filter({ hasText: "Te quedan 14 días de prueba gratis" })).toBeVisible();

  // El enlace es de un solo uso.
  await page.goto("/panel/verify-email?token=verificar-1");
  await expect(heading(page, "El enlace no es válido")).toBeVisible();
});

test("primeros pasos: sumar un profesional lo marca hecho; ocultarlos los saca del Inicio", async ({ page }) => {
  await login(page, "prueba@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  const steps = page.getByRole("region", { name: "Primeros pasos" });
  await expect(steps).toContainText("0 de 5 listos");

  await steps.getByRole("listitem").filter({ hasText: "Sumá a tu equipo" }).getByRole("link", { name: "Agregar" }).click();
  await expect(heading(page, "Equipo", 2)).toBeVisible();
  await page.getByRole("button", { name: "Agregar profesional" }).click();
  const dialog = page.getByRole("dialog", { name: "Agregar profesional" });
  await dialog.getByLabel("Nombre", { exact: true }).fill("Marta Rojas");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByRole("list", { name: "Profesionales" })).toContainText("Marta Rojas");

  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Inicio", exact: true }).click();
  await expect(steps).toContainText("1 de 5 listos");
  await expect(steps.getByRole("listitem").filter({ hasText: "Sumá a tu equipo" })).toContainText("(listo)");

  await steps.getByRole("button", { name: "Ocultar" }).click();
  await expect(steps).toBeHidden();
  await expect(page.getByText("Listo, ocultamos los primeros pasos.")).toBeVisible();
  await page.reload();
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toHaveCount(0);
});

test("validación: campos obligatorios y correo inválido; un correo que ya existe responde lo mismo", async ({ page }) => {
  await page.goto("/panel/signup");
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText("Escribí el nombre de tu negocio.")).toBeVisible();
  await expect(page.getByText("Escribí tu correo.")).toBeVisible();
  await expect(page.getByText("Usá al menos 8 caracteres.")).toBeVisible();

  await fillSignup(page, { business: "Salón X", name: "Ana", email: "ana@mailinator.com" });
  await expect(page.getByText("Escribí un correo válido.")).toBeVisible();

  // Correo con cuenta: la misma pantalla que un alta nueva (no revela que existe).
  await fillSignup(page, { business: "Otra clínica", name: "Daniela", email: "duena@demo.test" });
  await expect(heading(page, "Revisá tu correo")).toBeVisible();
  await expect(page.getByRole("link", { name: "Confirmar mi correo" })).toHaveCount(0);
});

test("sin confirmar: el login lo explica y permite reenviar el correo; un enlace inventado pide otro", async ({ page }) => {
  await fillSignup(page, { business: "Barbería Sur", name: "Pablo", email: "pablo@barberiasur.cr", password: "clave-de-pablo-1" });
  await expect(heading(page, "Revisá tu correo")).toBeVisible();
  await page.getByRole("button", { name: "Reenviar el correo" }).click();
  await expect(page.getByRole("button", { name: "Listo, te lo reenviamos" })).toBeVisible();

  await login(page, "pablo@barberiasur.cr", "clave-de-pablo-1");
  await expect(page.getByRole("alert").filter({ hasText: "Todavía no confirmaste tu correo" })).toBeVisible();
  await page.getByRole("button", { name: "Reenviar el correo de confirmación" }).click();
  await expect(page.getByRole("button", { name: "Listo, revisá tu correo" })).toBeVisible();

  await page.goto("/panel/verify-email?token=inventado");
  await expect(heading(page, "El enlace no es válido")).toBeVisible();
  await page.getByLabel("Correo", { exact: true }).fill("pablo@barberiasur.cr");
  await page.getByRole("button", { name: "Mandarme un enlace nuevo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "te llega un enlace nuevo" })).toBeVisible();
});

test("móvil (375 px): el alta sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/panel/signup");
  await expect(heading(page, "Probá Selyon CRM gratis")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
