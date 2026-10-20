import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de Clientes (I1) contra la API simulada (proyecto "panel-mock"): lista con búsqueda y
// "Ver más", alta, ficha editable, teléfono repetido, solo lectura para el profesional,
// estado vacío, anonimización con confirmación fuerte y móvil sin scroll horizontal. La
// clínica dental usa "pacientes"; Uñas Bella arranca sin clientes (web/src/modules/clients/clientsMock.ts).
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
}

const heading = (page: Page, name: string, level = 1) => page.getByRole("heading", { level, name, exact: true });
const rows = (page: Page) => page.getByRole("table").getByRole("row");

test("lista: busca sin tildes, pagina con Ver más y abre la ficha", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients");
  await expect(heading(page, "Pacientes")).toBeVisible();
  await expect(rows(page)).toHaveCount(51); // encabezado + 50
  await page.getByRole("button", { name: "Ver más" }).click();
  await expect(page.getByText("62 pacientes")).toBeVisible();

  await page.getByLabel("Buscar pacientes").fill("jimenez");
  await expect(page).toHaveURL(/q=jimenez/);
  const names = page.getByRole("table").getByRole("link");
  await expect(names.first()).toContainText("Jiménez");
  for (const text of await names.allTextContents()) expect(text).toContain("Jiménez");

  await page.getByLabel("Buscar pacientes").fill("nadie-se-llama-asi");
  await expect(page.getByText("No encontramos pacientes con «nadie-se-llama-asi»")).toBeVisible();

  await page.getByLabel("Buscar pacientes").fill("");
  await page.getByLabel("Ordenar por").selectOption("last_visit");
  await expect(page).toHaveURL(/sort=last_visit/);
  await names.first().click();
  await expect(page).toHaveURL(/\/panel\/clients\/[0-9a-f-]{36}$/);
  await expect(heading(page, "Historial de citas", 2)).toBeVisible();
  await expect(page.getByText("Llega con la Agenda")).toBeVisible();
  await page.getByRole("link", { name: "Volver a Pacientes" }).click();
  await expect(page).toHaveURL(/sort=last_visit/);
});

test("alta, edición y eliminación de datos con confirmación fuerte", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients");
  await page.getByRole("button", { name: "Nuevo paciente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo paciente" });
  await dialog.getByRole("button", { name: "Guardar paciente" }).click();
  await expect(dialog.getByText("Escribí el nombre.")).toBeVisible();

  // Teléfono de otro paciente → error en el campo.
  await dialog.getByLabel("Nombre").fill("Rocío Prueba");
  await dialog.getByLabel("Teléfono").fill("6000 0001");
  await dialog.getByRole("button", { name: "Guardar paciente" }).click();
  await expect(dialog.getByText(/Ya hay un paciente con ese teléfono/)).toBeVisible();

  await dialog.getByLabel("Teléfono").fill("8777-1234");
  await dialog.getByRole("button", { name: "Guardar paciente" }).click();
  await expect(heading(page, "Rocío Prueba")).toBeVisible();
  await expect(page.locator(".page-subtitle")).toHaveText("+506 8777 1234");

  // Editar: notas, etiqueta y preferencias; la barra de guardado aparece con cambios.
  await page.getByRole("textbox", { name: "Notas" }).fill("Sensibilidad en los dientes.");
  await page.getByLabel("Nueva etiqueta").fill("Ortodoncia");
  await page.getByLabel("Nueva etiqueta").press("Enter");
  await page.getByLabel("Sucursal preferida").selectOption({ label: "Heredia" });
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Notas" })).toHaveValue("Sensibilidad en los dientes.");
  await expect(page.getByRole("button", { name: "Quitar la etiqueta Ortodoncia" })).toBeVisible();

  // Correo como canal sin correo cargado → error en el campo, sin ir al servidor.
  await page.getByLabel("Recordatorios por").selectOption("email");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Para avisarle por correo, primero cargá su correo.")).toBeVisible();
  await page.getByRole("button", { name: "Descartar" }).click();

  // Eliminar datos: el botón se habilita recién con el teléfono correcto.
  await page.getByRole("button", { name: "Eliminar datos del paciente" }).click();
  const confirm = page.getByRole("dialog", { name: "¿Eliminar los datos de Rocío Prueba?" });
  const submit = confirm.getByRole("button", { name: "Eliminar sus datos" });
  await expect(submit).toBeDisabled();
  await confirm.getByLabel(/Para confirmar, escribí su teléfono/).fill("8777 1235");
  await expect(submit).toBeDisabled();
  await confirm.getByLabel(/Para confirmar, escribí su teléfono/).fill("8777 1234");
  await submit.click();
  await expect(page.getByText("Se eliminaron los datos del paciente.")).toBeVisible();
  await expect(heading(page, "Paciente eliminado")).toBeVisible();
  await expect(page.getByText("Los datos de este paciente se eliminaron")).toBeVisible();
  await expect(page.getByRole("button", { name: "Eliminar datos del paciente" })).toHaveCount(0);

  // Ya no aparece en la lista.
  await page.goto("/panel/clients?q=Rocío");
  await expect(page.getByText("No encontramos pacientes con «Rocío»")).toBeVisible();
});

test("+ Nuevo › Paciente abre el alta desde cualquier sección", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("button", { name: "Nuevo", exact: true }).click();
  await page.getByRole("menuitem", { name: /Paciente/ }).click();
  await expect(page).toHaveURL(/\/panel\/clients\?new=1$/);
  const dialog = page.getByRole("dialog", { name: "Nuevo paciente" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Nombre")).toBeFocused();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(page).toHaveURL(/\/panel\/clients$/);
});

test("profesional: ve la lista y la ficha en solo lectura, sin alta ni eliminar", async ({ page }) => {
  await login(page, "profesional@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Mis pacientes" }).click();
  await expect(heading(page, "Mis pacientes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo paciente" })).toHaveCount(0);
  await page.getByRole("table").getByRole("link").first().click();
  await expect(page.getByText("Solo lectura: tu rol puede ver la ficha, no editarla.")).toBeVisible();
  await expect(page.getByLabel("Nombre")).toBeDisabled();
  await expect(page.getByRole("button", { name: /Eliminar datos/ })).toHaveCount(0);
});

test("negocio sin clientes: estado vacío con la acción de alta", async ({ page }) => {
  await login(page, "sinagente@demo.test");
  await page.goto("/panel/clients");
  await expect(page.getByText("Todavía no tenés clientes")).toBeVisible();
  await page.getByRole("button", { name: "Nuevo cliente" }).last().click();
  await expect(page.getByRole("dialog", { name: "Nuevo cliente" })).toBeVisible();
});

test("ficha inexistente: lo explica sin romper", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients/00000000-0000-4000-8000-000000000000");
  await expect(heading(page, "Ficha del paciente")).toBeVisible();
  await expect(page.getByText("No encontramos este paciente")).toBeVisible();
});

test("móvil (375 px): lista y ficha sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.goto("/panel/clients");
  await expect(rows(page).nth(1)).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole("table").getByRole("link").first().click();
  await expect(heading(page, "Historial de citas", 2)).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
});
