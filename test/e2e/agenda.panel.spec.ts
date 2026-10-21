import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de la Agenda, el Inicio básico y el historial de la ficha (I1) contra la API
// simulada (proyecto "panel-mock"): agendar desde "Nueva cita" con un horario libre,
// confirmar, reprogramar y cancelar desde el panel lateral; "+ Nuevo → Cita"; vista
// semana; el profesional ve solo su carril; las tarjetas del Inicio según el plan; y
// móvil (375 px) sin scroll horizontal. Datos de web/src/modules/scheduling/schedulingMock.ts
// (citas sembradas alrededor de hoy) y de la Configuración simulada (horarios).
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

/** Día de Costa Rica (UTC−6) dentro de `days` días. */
function crDate(days: number): string {
  const d = new Date(Date.now() - 6 * 3600_000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** El próximo lunes a 7+ días (fuera de las citas sembradas; la Dra. Ruiz atiende en Escazú). */
function freeMonday(): string {
  for (let i = 7; i < 14; i++) {
    const date = crDate(i);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
  }
  throw new Error("sin lunes");
}

test("agendar, confirmar, reprogramar y cancelar una cita", async ({ page }) => {
  await login(page, "duena@demo.test");
  const monday = freeMonday();
  await page.goto(`/panel/agenda?date=${monday}`);
  await expect(heading(page, "Agenda")).toBeVisible();
  await expect(page.getByRole("group", { name: "Carril de Dra. Carmen Ruiz" })).toBeVisible();

  await page.getByRole("button", { name: "Nueva cita" }).click();
  const dialog = page.getByRole("dialog", { name: "Nueva cita" });
  await expect(dialog).toBeVisible();
  // Sin cliente: no deja agendar.
  await dialog.getByRole("button", { name: "Agendar cita" }).click();
  await expect(dialog.getByText("Elegí el paciente.")).toBeVisible();

  await dialog.getByLabel("Buscar paciente").fill("María Fernández");
  await dialog.getByRole("button", { name: /María Fernández/ }).first().click();
  await expect(dialog.getByText("María Fernández")).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Limpieza dental/ }).check();
  await expect(dialog.getByLabel("Fecha")).toHaveValue(monday);
  const slots = dialog.getByRole("radiogroup", { name: "Horarios disponibles" });
  await expect(slots.getByRole("radio").first()).toBeVisible();
  // La Dra. Ruiz empieza a las 8:00 y almuerza de 12 a 13: no hay horario a las 12:30.
  await expect(slots.getByRole("radio").first()).toContainText("8:00");
  await expect(slots.getByRole("radio", { name: /^12:30/ })).toHaveCount(0);
  await slots.getByRole("radio").first().click();
  await expect(dialog.getByText(/con Dra\. Carmen Ruiz/)).toBeVisible();
  await dialog.getByRole("button", { name: "Agendar cita" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Cita agendada: María Fernández/)).toBeVisible();

  const block = page.getByRole("button", { name: /María Fernández, Limpieza dental, Sin confirmar/ });
  await expect(block).toBeVisible();
  await block.click();
  const drawer = page.getByRole("dialog", { name: "María Fernández" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Sin confirmar")).toBeVisible();
  // Todavía no empezó: completar y no-show deshabilitados.
  await expect(drawer.getByRole("button", { name: "Completar" })).toBeDisabled();
  await drawer.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Cita confirmada.")).toBeVisible();
  await expect(drawer.getByText("Confirmada", { exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "Reprogramar" }).click();
  const moveSlots = drawer.getByRole("radiogroup", { name: "Horarios para reprogramar" });
  await moveSlots.getByRole("radio").nth(8).click();
  await drawer.getByRole("button", { name: /Mover a las/ }).click();
  await expect(page.getByText(/Cita movida a/)).toBeVisible();

  await drawer.getByRole("button", { name: "Cancelar cita" }).click();
  await drawer.getByRole("button", { name: "Cancelar cita" }).click();
  await expect(drawer.getByText("Contanos el motivo (queda en el historial).")).toBeVisible();
  await drawer.getByLabel("Motivo").fill("La paciente avisó que no puede");
  await drawer.getByRole("button", { name: "Cancelar cita" }).click();
  await expect(drawer.getByText("Cancelada", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/La paciente avisó que no puede/)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Reprogramar" })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Cerrar" }).click();

  // Las canceladas se ocultan; con "Ver canceladas" vuelven.
  await expect(page.getByRole("button", { name: /María Fernández/ })).toHaveCount(0);
  await page.getByLabel("Ver canceladas").check();
  await expect(page.getByRole("button", { name: /María Fernández, Limpieza dental, Cancelada/ })).toBeVisible();
});

test('"+ Nuevo → Cita" abre el diálogo y la vista semana navega', async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("button", { name: "Nuevo" }).click();
  await page.getByRole("menuitem", { name: /Cita/ }).click();
  await expect(page).toHaveURL(/\/panel\/agenda/);
  const dialog = page.getByRole("dialog", { name: "Nueva cita" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Semana" }).click();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.getByRole("region", { name: /^Lun/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Dom/ })).toBeVisible();
  const before = await page.locator(".agenda-date").textContent();
  await page.getByRole("button", { name: "Semana siguiente" }).click();
  await expect(page.locator(".agenda-date")).not.toHaveText(before ?? "");
  // Del día de la semana a la vista día.
  await page.getByRole("button", { name: /^Ver el día/ }).first().click();
  await expect(page).not.toHaveURL(/view=week/);
  await expect(page.getByRole("button", { name: "Día", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("profesional: solo su carril y sin reasignar", async ({ page }) => {
  await login(page, "profesional@demo.test");
  await expect(heading(page, "Mi agenda")).toBeVisible();
  await expect(page.locator(".lane-header")).toHaveText(["Dr. Carlos Rojas"]);
  await page.getByRole("button", { name: "Semana" }).click();
  const items = page.locator(".week-item");
  await expect(items.first()).toBeVisible();
  for (const meta of await page.locator(".week-item-meta").allTextContents()) expect(meta).toContain("Dr. Carlos Rojas");
  await items.first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Reasignar" })).toHaveCount(0);
});

test("Inicio: tarjetas del día y las del agente según el plan", async ({ page }) => {
  await login(page, "duena@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  for (const title of ["Citas de hoy", "Próximas citas", "Sin confirmar (hoy y mañana)", "No asistieron hoy", "Agendadas por el agente esta semana", "Conversaciones esperando"]) {
    await expect(heading(page, title, 2)).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Conversaciones esperando" }).getByRole("link", { name: "Ir a la bandeja" })).toBeVisible();
  // Una próxima cita lleva a la agenda con su detalle abierto.
  const upcoming = page.getByRole("region", { name: "Próximas citas" }).getByRole("link").first();
  await upcoming.click();
  await expect(page).toHaveURL(/\/panel\/agenda\?date=\d{4}-\d{2}-\d{2}&appointment=/);
  await expect(page.getByRole("dialog")).toBeVisible();

  // Pro sin agente: sin las tarjetas de WhatsApp.
  await page.goto("/panel/login");
  await page.evaluate(() => sessionStorage.clear());
  await login(page, "sinagente@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(heading(page, "Citas de hoy", 2)).toBeVisible();
  await expect(heading(page, "Agendadas por el agente esta semana", 2)).toHaveCount(0);
});

test("ficha: historial de citas y agendar con el paciente ya elegido", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients/c1000000-0000-4000-8000-000000000001");
  await expect(heading(page, "María Fernández")).toBeVisible();
  await expect(heading(page, "Historial de citas", 2)).toBeVisible();
  await page.getByRole("button", { name: "Agendar cita" }).click();
  const dialog = page.getByRole("dialog", { name: "Nueva cita" });
  await expect(dialog.getByText("María Fernández")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cambiar" })).toBeVisible();
});

test("móvil (375 px): agenda y nueva cita sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  await page.goto("/panel/agenda");
  await expect(heading(page, "Agenda")).toBeVisible();
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole("button", { name: "Semana" }).click();
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole("button", { name: "Nueva cita" }).click();
  await expect(page.getByRole("dialog", { name: "Nueva cita" })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
});
