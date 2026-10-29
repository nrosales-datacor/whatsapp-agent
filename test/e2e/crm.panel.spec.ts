import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del CRM de clientes (I3, plan Pro) contra la API simulada (proyecto "panel-mock"):
// chips de estado con su cantidad, filtros y orden por gasto, exportar CSV, el asistente de
// importación (mapeo, vista previa, errores por fila), campos personalizados y VIP en la
// ficha, Configuración › Campos personalizados y › Reglas, "Mis pacientes" del profesional,
// candados en el Básico y móvil sin scroll horizontal. La clínica dental (Pro) usa
// "pacientes"; Estética Aurora es Básico (web/src/modules/clients/{clientsMock,crmMock}.ts).
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
}

const chips = (page: Page) => page.getByRole("group", { name: "Filtrar por estado" });
const tableRows = (page: Page) => page.getByRole("table").locator("tbody tr");

async function openSettings(page: Page, section: string) {
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configuración", exact: true }).click();
  await page.getByRole("navigation", { name: "Secciones de configuración" }).getByRole("link", { name: section, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: section, exact: true })).toBeVisible();
}

test("Pro: chips por estado con su cantidad, filtros por etiqueta y orden por gasto", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients");
  const all = chips(page).getByRole("button", { name: /^Todos/ });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(all).toContainText("62");
  await expect(page.getByRole("columnheader", { name: "Estado" })).toBeVisible();

  // Un chip: la URL guarda el filtro y todas las filas tienen ese estado; la cantidad cuadra.
  const atRisk = chips(page).getByRole("button", { name: /^En riesgo/ });
  await expect(atRisk.locator(".clients-chip-count")).toBeVisible();
  const count = Number((await atRisk.locator(".clients-chip-count").textContent()) ?? "0");
  expect(count).toBeGreaterThan(0);
  await atRisk.click();
  await expect(page).toHaveURL(/status=at_risk/);
  await expect(atRisk).toHaveAttribute("aria-pressed", "true");
  await expect(tableRows(page)).toHaveCount(count);
  for (const cell of await page.locator("td.clients-col-status").allTextContents()) expect(cell).toBe("En riesgo");

  // Filtros: etiqueta (los chips se recalculan con el filtro) y limpiar.
  await atRisk.click();
  await page.getByRole("button", { name: /^Filtros/ }).click();
  const filters = page.getByRole("region", { name: "Filtros" });
  await filters.getByLabel(/^Ortodoncia/).click();
  await expect(filters.getByLabel(/^Ortodoncia/)).toBeChecked();
  await expect(page).toHaveURL(/tag=Ortodoncia/);
  await expect(all.locator(".clients-chip-count")).not.toHaveText("62");
  const tagged = await tableRows(page).count();
  expect(tagged).toBeGreaterThan(0);
  for (let i = 0; i < tagged; i++) await expect(tableRows(page).nth(i)).toContainText("Ortodoncia");
  await filters.getByLabel("VIP", { exact: true }).selectOption("true");
  await expect(page).toHaveURL(/vip=true/);
  await filters.getByRole("button", { name: "Limpiar filtros" }).click();
  await expect(all.locator(".clients-chip-count")).toHaveText("62");

  // Orden por gasto: de mayor a menor.
  await page.getByLabel("Ordenar por").selectOption("total_spent");
  await expect(page).toHaveURL(/sort=total_spent/);
  const spendSorted = async () => {
    const spend = (await page.locator("td.clients-col-spend").allTextContents()).map((s) => Number(s.replace(/[^\d]/g, "")));
    return spend.length > 5 && spend.every((v, i) => i === 0 || spend[i - 1] >= v);
  };
  await expect.poll(spendSorted).toBe(true);
});

test("Pro: exportar descarga un CSV con BOM y los filtros aplicados", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients?status=vip");
  await expect(tableRows(page).first()).toBeVisible();
  const vipRows = await tableRows(page).count();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^pacientes-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile((await download.path()) as string, "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.trim().split("\r\n");
  expect(lines[0]).toContain("Nombre,Teléfono,Correo");
  expect(lines[0]).toContain("Alergias");
  expect(lines.length - 1).toBe(vipRows);
  await expect(page.getByText(/descargamos tus pacientes en CSV/)).toBeVisible();
});

test("Pro: el asistente de importación mapea columnas, muestra la vista previa con errores e importa", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients");
  await page.getByRole("button", { name: "Importar" }).click();
  const dialog = page.getByRole("dialog", { name: "Importar pacientes" });
  const csv =
    "﻿Nombre;Celular;Correo;Alergias;Notas internas\r\n" +
    '"Rojas; Ana Lucía";8111 2222;ana@example.com;Látex;nada\r\n' +
    "Bruno Prueba;8111 3333;;;\r\n" +
    "Repetida;8111 2222;;;\r\n" +
    "Mal Correo;8111 4444;no-es-correo;;\r\n" +
    "María Fernández;6000 0001;;Penicilina;\r\n";
  await dialog.getByLabel("Archivo CSV").setInputFiles({ name: "pacientes.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await dialog.getByRole("button", { name: "Siguiente" }).click();

  await expect(dialog.getByLabel("La primera fila son los nombres de las columnas")).toBeChecked();
  await expect(dialog.getByLabel("Dato de la columna Celular")).toHaveValue("phone");
  await expect(dialog.getByLabel("Dato de la columna Alergias")).toHaveValue("custom:allergies");
  await expect(dialog.getByLabel("Dato de la columna Notas internas")).toHaveValue("");
  // La columna sin sugerencia se puede asignar a mano.
  await dialog.getByLabel("Dato de la columna Notas internas").selectOption("notes");
  await expect(dialog.getByLabel("Dato de la columna Notas internas")).toHaveValue("notes");

  const preview = dialog.getByRole("region", { name: "Vista previa" });
  await expect(preview).toContainText("2 nuevos");
  await expect(preview).toContainText("1 a actualizar");
  await expect(preview).toContainText("2 con errores");
  await expect(preview.getByRole("row").filter({ hasText: "Rojas; Ana Lucía" })).toContainText("Crear");
  await expect(preview.getByRole("row").filter({ hasText: "Repetida" })).toContainText("Teléfono repetido en el archivo (ya está en la fila 2)");
  await expect(preview.getByRole("row").filter({ hasText: "Mal Correo" })).toContainText("Correo inválido");

  await dialog.getByRole("button", { name: "Importar 3 pacientes" }).click();
  await expect(dialog.getByRole("status")).toContainText("Se crearon 2 y se actualizaron 1 pacientes");
  await expect(dialog.getByText("2 filas con error (no se importan)")).toBeVisible();
  await dialog.getByRole("button", { name: "Listo" }).click();
  await expect(dialog).toBeHidden();

  await page.getByLabel("Buscar pacientes").fill("Ana Lucía");
  await expect(page.getByRole("table").getByRole("link", { name: "Rojas; Ana Lucía" })).toBeVisible();
  await page.getByRole("table").getByRole("link", { name: "Rojas; Ana Lucía" }).click();
  await expect(page.getByRole("textbox", { name: "Alergias" })).toHaveValue("Látex");
});

test("Pro: campos personalizados en Configuración y en la ficha, con VIP manual", async ({ page }) => {
  await login(page, "duena@demo.test");
  await openSettings(page, "Campos personalizados");
  await page.getByRole("button", { name: "Nuevo campo" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo campo" });
  await dialog.getByLabel("Nombre").fill("Tipo de sonrisa");
  await dialog.getByLabel("Tipo").selectOption("select");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog.getByText("Cargá al menos dos opciones (una por línea).")).toBeVisible();
  await dialog.getByLabel("Opciones (una por línea)").fill("Gingival\nAlta\nMedia");
  await dialog.getByLabel("Obligatorio").check();
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog).toBeHidden();
  const list = page.getByRole("list", { name: "Campos: Ficha del paciente" });
  await expect(list.getByRole("listitem").filter({ hasText: "Tipo de sonrisa" })).toContainText("Una opción: Gingival, Alta, Media");

  // Desactivar un campo: queda en la lista como desactivado y se puede reactivar.
  await list.getByRole("button", { name: "Desactivar el campo Seguro médico" }).click();
  await page.getByRole("dialog", { name: "Desactivar el campo" }).getByRole("button", { name: "Desactivar" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "Seguro médico" })).toContainText("Desactivado");

  // La ficha: el obligatorio se pide, se guarda con VIP y queda al recargar.
  await page.goto("/panel/clients?q=jimenez");
  await page.getByRole("table").getByRole("link").first().click();
  const custom = page.getByRole("region", { name: "Datos adicionales" });
  await expect(custom.getByLabel("Seguro médico")).toHaveCount(0);
  await custom.getByLabel("Alergias").fill("Ibuprofeno");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(custom.getByText("Campo obligatorio.")).toBeVisible();
  await custom.getByLabel("Tipo de sonrisa *").selectOption("Alta");
  await page.getByLabel("Marcar como VIP").check();
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Datos adicionales" }).getByLabel("Tipo de sonrisa *")).toHaveValue("Alta");
  await expect(page.getByLabel("Marcar como VIP")).toBeChecked();
  await expect(page.locator(".client-header-status").getByRole("img", { name: "VIP" })).toBeVisible();
});

test("Pro: reglas de pacientes con validación y restaurar las del rubro", async ({ page }) => {
  await login(page, "duena@demo.test");
  await openSettings(page, "Reglas de pacientes");
  const form = page.getByRole("form", { name: "Reglas de pacientes" });
  await expect(form.getByLabel("Días como nuevo")).toHaveValue("90");
  await form.getByLabel("Días sin volver para inactivo").fill("100");
  await form.getByRole("button", { name: "Guardar reglas" }).click();
  await expect(form.getByText("Tienen que ser más días que los de «en riesgo».")).toBeVisible();
  await form.getByLabel("Según su frecuencia").check();
  await form.getByLabel("Veces su intervalo promedio entre visitas").fill("1,5");
  await form.getByLabel("Días sin volver para inactivo").fill("500");
  await form.getByRole("button", { name: "Guardar reglas" }).click();
  await expect(page.getByText(/Reglas guardadas/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Veces su intervalo promedio entre visitas")).toHaveValue("1,5");
  await page.getByRole("button", { name: "Restaurar las del rubro" }).click();
  await expect(page.getByLabel("Días sin volver para inactivo")).toHaveValue("400");
  await expect(page.getByLabel("Días sin volver", { exact: true })).toHaveValue("210");
});

test("profesional: Mis pacientes muestra solo los suyos y la ficha de otro no se abre", async ({ page }) => {
  await login(page, "profesional@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Mis pacientes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mis pacientes" })).toBeVisible();
  const totalChip = chips(page).getByRole("button", { name: /^Todos/ }).locator(".clients-chip-count");
  await expect(totalChip).toBeVisible();
  const total = Number(await totalChip.textContent());
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(62);
  await expect(tableRows(page)).toHaveCount(total);
  await expect(page.getByRole("button", { name: "Importar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Exportar" })).toHaveCount(0);
  // La última de la semilla nunca tiene citas: no es suya.
  await page.goto("/panel/clients/c1000000-0000-4000-8000-000000000062");
  await expect(page.getByText("No encontramos este paciente")).toBeVisible();
});

test("Básico: estados, filtros, importar y exportar con candado; Configuración del CRM bloqueada", async ({ page }) => {
  await login(page, "basico@demo.test");
  await page.goto("/panel/clients");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Estado" })).toHaveCount(0);
  await expect(page.getByLabel("Ordenar por").locator("option")).toHaveText(["Nombre", "Última visita"]);
  await page.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Disponible en el plan Pro" })).toContainText("Importar desde CSV es parte del plan Pro");
  await page.getByRole("dialog", { name: "Disponible en el plan Pro" }).getByRole("button", { name: "Entendido" }).click();
  await page.getByRole("button", { name: /^Filtros/ }).click();
  await expect(page.getByRole("dialog", { name: "Disponible en el plan Pro" })).toContainText("Los filtros de clientes es parte del plan Pro");
  await page.getByRole("dialog", { name: "Disponible en el plan Pro" }).getByRole("button", { name: "Entendido" }).click();

  // La ficha básica sigue: sin estado ni datos adicionales.
  await page.getByRole("table").getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 2, name: "Datos", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Datos adicionales" })).toHaveCount(0);
  await expect(page.getByLabel("Marcar como VIP")).toHaveCount(0);

  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configuración", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Secciones de configuración" });
  await expect(nav.getByRole("button", { name: "Reglas de clientes (disponible en el plan Pro)" })).toBeVisible();
  await page.goto("/panel/settings/client-rules");
  await expect(page.getByText("Disponible en el plan Pro")).toBeVisible();
});

test("móvil (375 px): chips y lista del CRM sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients?status=vip");
  await expect(tableRows(page).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: /^Filtros/ }).click();
  await expect(page.getByRole("region", { name: "Filtros" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
