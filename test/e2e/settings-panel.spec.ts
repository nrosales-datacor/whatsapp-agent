import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de Configuración (I1) contra la API simulada (proyecto "panel-mock", ver
// playwright.config.ts: este archivo entra por terminar en "panel.spec.ts"). Recorre
// servicios con precio en céntimos, horario con descanso, equipo, modo lectura de
// recepción y candados del plan. El estado del mock vive en sessionStorage: cada test
// arranca limpio.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
}

async function openSettings(page: Page, section: string) {
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configuración", exact: true }).click();
  await page.getByRole("navigation", { name: "Secciones de configuración" }).getByRole("link", { name: section, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: section, exact: true })).toBeVisible();
}

test("dueña: crea un servicio con precio en la moneda del negocio y lo reordena", async ({ page }) => {
  await login(page, "duena@demo.test");
  await openSettings(page, "Servicios");

  await page.getByRole("button", { name: "Nuevo servicio" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo servicio" });
  await dialog.getByLabel("Nombre", { exact: true }).fill("Sellantes");
  await dialog.getByLabel("Precio (CRC)").fill("15 000,50");
  await expect(dialog.getByText(/Se muestra como ₡15\s000,50/)).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog).toBeHidden();
  const item = page.getByRole("listitem").filter({ hasText: "Sellantes" });
  await expect(item).toContainText(/₡15\s000,50/);

  // Subir el servicio nuevo un lugar dentro de su categoría.
  const category = page.getByRole("region", { name: "Diagnóstico y prevención" });
  await item.getByRole("button", { name: "Subir Sellantes" }).click();
  await expect(category.getByRole("listitem").nth(1)).toContainText("Sellantes");
});

test("dueña: horario de una sucursal con un segundo tramo el mismo día", async ({ page }) => {
  await login(page, "duena@demo.test");
  await openSettings(page, "Sucursales");

  await page.getByRole("button", { name: "Horario de Escazú" }).click();
  const dialog = page.getByRole("dialog", { name: "Horario de Escazú" });
  await dialog.getByRole("button", { name: "+ Agregar tramo el lunes" }).click();
  await expect(dialog.getByLabel("Lunes, inicio del tramo 2")).toHaveValue("19:00");
  await dialog.getByRole("button", { name: "Guardar horario" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Escazú" })).toContainText("Lun 8:00–18:00, 19:00–23:00");
});

test("dueña: suma un profesional al equipo; recepción ve la configuración en modo lectura", async ({ page }) => {
  await login(page, "duena@demo.test");
  await openSettings(page, "Equipo");
  await page.getByRole("button", { name: "Agregar profesional" }).click();
  const dialog = page.getByRole("dialog", { name: "Agregar profesional" });
  await dialog.getByLabel("Nombre", { exact: true }).fill("Laura Méndez");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByRole("list", { name: "Profesionales" })).toContainText("Laura Méndez");

  await page.getByRole("button", { name: "Menú de Daniela Mora" }).click();
  await page.getByRole("menuitem", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/panel\/login$/);
  await login(page, "recepcion@demo.test");
  await openSettings(page, "Servicios");
  await expect(page.getByText("modo lectura")).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo servicio" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Secciones de configuración" }).getByText("Usuarios y permisos")).toHaveCount(0);
});

test("plan Básico: métodos de pago y campos personalizados con candado", async ({ page }) => {
  await login(page, "basico@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configuración", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Secciones de configuración" });
  await expect(nav.getByRole("button", { name: "Campos personalizados (disponible en el plan Pro)" })).toBeVisible();
  await nav.getByRole("button", { name: "Métodos de pago (disponible en el plan Pro)" }).click();
  await expect(page.getByRole("dialog", { name: "Disponible en el plan Pro" })).toContainText("Métodos de pago es parte del plan Pro");
});
