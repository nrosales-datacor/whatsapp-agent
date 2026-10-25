import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del alta self-service y del pago en línea (I6.6–I6.7) contra la API simulada
// (proyecto "panel-mock"): "Crear una cuenta" desde el login, validación del formulario,
// "Revisá tu correo", login bloqueado hasta confirmar (con reenviar el enlace), el link de
// confirmación (y uno inválido), el aviso de la prueba que vence, suscribirse desde
// Configuración › Plan (Checkout simulado) y "Administrar pago", el aviso solo para dueño y
// administración, y móvil sin scroll horizontal. Datos: web/src/lib/mockApi.ts.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

const banner = (page: Page) => page.locator(".billing-banner");

test("alta self-service: formulario, confirmar el correo y entrar al negocio nuevo en prueba", async ({ page }) => {
  await page.goto("/panel/login");
  await page.getByRole("link", { name: "Crear una cuenta" }).click();
  await expect(page).toHaveURL(/\/panel\/signup$/);
  await expect(page.getByRole("heading", { level: 1, name: "Creá la cuenta de tu negocio" })).toBeVisible();
  await expect(page.getByText("Probalo gratis 14 días.", { exact: false })).toBeVisible();

  // Sin completar: los errores de cada campo, sin mandar nada.
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText("Escribí el nombre de tu negocio.")).toBeVisible();
  await expect(page.getByText("Tenés que aceptar los términos y el aviso de privacidad.")).toBeVisible();

  await page.getByLabel("Nombre del negocio").fill("Spa Luna");
  await page.getByLabel("Rubro").selectOption("aesthetics");
  await page.getByLabel("País").selectOption("PA");
  await page.getByLabel("Plan").selectOption("pro");
  await page.getByLabel("Tu nombre").fill("Laura Pinto");
  await page.getByLabel("Correo", { exact: true }).fill("laura@spaluna.test");
  await page.getByLabel("Clave", { exact: true }).fill("clave-de-laura");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Revisá tu correo" })).toBeVisible();
  await expect(page.getByText("laura@spaluna.test")).toBeVisible();
  await page.getByRole("button", { name: "Reenviar el enlace" }).click();
  await expect(page.getByText("te llega un enlace nuevo")).toBeVisible();

  // Sin confirmar no entra: el mensaje lo dice y ofrece reenviar el enlace.
  await login(page, "laura@spaluna.test", "clave-de-laura");
  await expect(page.getByText("Todavía no confirmaste tu correo.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reenviar el enlace de confirmación" }).click();
  await expect(page.getByText("te mandamos un enlace nuevo", { exact: false })).toBeVisible();

  // El link del correo confirma y lleva a ingresar.
  await page.goto("/panel/verify-email?token=confirmar");
  await expect(page.getByRole("heading", { level: 1, name: "¡Correo confirmado!" })).toBeVisible();
  await page.getByRole("link", { name: "Ingresar" }).click();
  await login(page, "laura@spaluna.test", "clave-de-laura");
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  // Prueba de 14 días: todavía sin aviso arriba (aparece en la última semana).
  await expect(banner(page)).toHaveCount(0);

  await page.goto("/panel/settings/plan");
  await expect(page.getByText("Tu prueba gratis termina en 14 días.")).toBeVisible();
  await expect(page.getByText("En prueba", { exact: true })).toBeVisible();
});

test("link de confirmación inválido o usado: lo explica y lleva a ingresar", async ({ page }) => {
  await page.goto("/panel/verify-email?token=otro");
  await expect(page.getByRole("heading", { level: 1, name: "El enlace no funciona" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("no es válido o venció");
  await page.goto("/panel/verify-email");
  await expect(page.getByText("Al enlace le falta una parte.")).toBeVisible();
  await page.getByRole("link", { name: "Ir a ingresar" }).click();
  await expect(page).toHaveURL(/\/panel\/login$/);
});

test("prueba que vence: aviso al dueño, suscribirse desde Configuración › Plan y administrar el pago", async ({ page }) => {
  await login(page, "basico@demo.test");
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(banner(page)).toContainText("Tu prueba gratis termina en 5 días.");
  await banner(page).getByRole("link", { name: "Ver mi plan" }).click();
  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);

  const billing = page.getByRole("region", { name: "Pago" });
  await expect(billing).toBeVisible();
  for (const label of ["Básico", "Pro", "Pro sin agente"]) await expect(billing.getByText(label, { exact: true })).toBeVisible();
  await expect(billing.getByRole("button", { name: "Administrar pago" })).toHaveCount(0);

  // Checkout (simulado): vuelve a Plan con el aviso, el plan Pro al día y sin el aviso de la prueba.
  await billing.getByRole("button", { name: "Suscribirme al Pro", exact: true }).click();
  await expect(page.getByText("¡Listo! Recibimos tu suscripción.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/panel\/settings\/plan$/);
  await expect(page.getByText("Al día", { exact: true })).toBeVisible();
  await expect(page.locator("p.page-subtitle-heading")).toHaveText("Pro");
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Pago" }).getByRole("button", { name: "Administrar pago" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pago" }).getByRole("button", { name: /Suscribirme/ })).toHaveCount(0);
});

test("el aviso del cobro es de dueño y administración; recepción no lo ve", async ({ page }) => {
  await login(page, "recepcion@demo.test");
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test("móvil: el alta sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/panel/signup");
  await expect(page.getByRole("heading", { level: 1, name: "Creá la cuenta de tu negocio" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
