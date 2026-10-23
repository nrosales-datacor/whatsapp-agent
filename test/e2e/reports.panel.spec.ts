import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de Reportes, Inicio completo y Métricas del superadmin (I5) contra la API simulada
// (proyecto "panel-mock"): las cinco pestañas con su período (presets y personalizado) y
// sucursal en la URL, los gráficos SVG con su tabla equivalente, Exportar CSV (descarga
// con nombre, BOM y encabezados), el Inicio completo del Pro (y el básico del Básico), el
// candado del plan Básico, recepción sin Reportes, el superadmin con Métricas y la
// actividad de un negocio, y móvil sin scroll horizontal. Datos: web/src/modules/reports/
// reportsMock.ts (sobre la Agenda y Ventas simuladas) y admin/adminMetricsMock.ts.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";
const TOTP_CODE = "123456";

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
}

const heading = (page: Page, name: string | RegExp, level = 1) => page.getByRole("heading", { level, name, exact: typeof name === "string" });

/** Día de Costa Rica (UTC−6) dentro de `days` días. */
function crDate(days: number): string {
  const d = new Date(Date.now() - 6 * 3600_000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("Reportes (Pro): Ventas con indicadores, gráfico con su tabla, período en la URL y exportar CSV", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Reportes", exact: true }).click();
  await expect(page).toHaveURL(/\/panel\/reports$/);
  await expect(heading(page, "Reportes")).toBeVisible();
  await expect(page).toHaveTitle("Ventas · Reportes · Selyon CRM");

  const kpis = page.getByLabel("Indicadores de ventas");
  for (const label of ["Neto cobrado", "Señas", "Devoluciones", "Ticket promedio"]) await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  const chart = page.getByRole("img", { name: /Neto cobrado por día/ });
  await expect(chart).toBeVisible();
  // El gráfico es enfocable y muestra el detalle de un día con las flechas.
  await chart.focus();
  await page.keyboard.press("End");
  await expect(page.locator(".rp-tooltip")).toBeVisible();
  // Tabla equivalente para quien no ve el gráfico.
  const salesDay = page.getByRole("region", { name: "Ingresos por día" });
  await salesDay.getByText("Ver los datos en una tabla").click();
  await expect(salesDay.getByRole("table")).toBeVisible();
  await expect(salesDay.getByRole("row")).toHaveCount(31, { timeout: 10_000 }); // encabezado + 30 días
  await expect(page.getByRole("img", { name: /Neto cobrado por método de pago/ })).toBeVisible();

  // Presets: 7 días queda en la URL; personalizado muestra Desde/Hasta.
  // (El período vive en la URL: el radio se marca cuando la navegación termina, por eso click + espera.)
  await page.getByRole("radio", { name: "7 días" }).click();
  await expect(page.getByRole("radio", { name: "7 días" })).toBeChecked();
  await expect(page).toHaveURL(/days=7/);
  await expect(salesDay.getByRole("row")).toHaveCount(8);
  await page.getByRole("radio", { name: "Personalizado" }).click();
  await expect(page.getByRole("radio", { name: "Personalizado" })).toBeChecked();
  await page.getByLabel("Desde", { exact: true }).fill(crDate(-2));
  await expect(page).toHaveURL(new RegExp(`from=${crDate(-2)}`));
  await expect(salesDay.getByRole("row")).toHaveCount(4);
  await page.getByLabel("Desde", { exact: true }).fill(crDate(1));
  await expect(page.getByText("La fecha «Hasta» tiene que ser igual o posterior a «Desde».")).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeDisabled();
  await page.getByLabel("Desde", { exact: true }).fill(crDate(-6));

  // Exportar CSV: descarga con nombre, BOM y encabezados con la moneda.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`reporte-ventas_${crDate(-6)}_${crDate(0)}.csv`);
  const csv = readFileSync((await download.path()) as string, "utf8");
  expect(csv.startsWith("﻿")).toBe(true);
  const lines = csv.slice(1).trimEnd().split("\r\n");
  expect(lines[0]).toBe("Fecha,Cobrado (CRC),Devoluciones (CRC),Neto (CRC),Movimientos");
  expect(lines).toHaveLength(8);
  await expect(page.getByText(/Listo: se descargó reporte-ventas_/)).toBeVisible();
});

test("Reportes (Pro): las cinco pestañas conservan el período; sucursal; servicios por cantidad e ingresos", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/reports?days=7");
  const tabs = page.getByRole("navigation", { name: "Secciones de Reportes" });
  await expect(tabs.getByRole("link")).toHaveText(["Ventas", "Servicios", "Profesionales", "Pacientes", "Canales"]);

  await tabs.getByRole("link", { name: "Servicios" }).click();
  await expect(page).toHaveURL(/\/panel\/reports\/services\?days=7$/);
  await expect(page.getByLabel("Indicadores de servicios").getByText("Servicios realizados")).toBeVisible();
  const services = page.getByRole("table", { name: "Servicios del período" });
  await expect(services.getByRole("row").nth(1)).toBeVisible();
  await page.getByRole("button", { name: "Por ingresos" }).click();
  await expect(page.getByRole("button", { name: "Por ingresos" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("img", { name: /Servicios más vendidos por ingresos/ })).toBeVisible();

  await tabs.getByRole("link", { name: "Profesionales" }).click();
  await expect(page).toHaveTitle("Profesionales · Reportes · Selyon CRM");
  await expect(page.getByLabel("Indicadores de profesionales").getByText("Ocupación", { exact: true })).toBeVisible();
  const staff = page.getByRole("table", { name: "Profesionales del período" });
  await expect(staff.getByRole("rowheader", { name: /Dra\. Carmen Ruiz/ })).toBeVisible();
  await expect(staff.getByRole("img", { name: /Ocupación de Dra\. Carmen Ruiz: \d/ })).toBeVisible();

  await tabs.getByRole("link", { name: "Pacientes" }).click();
  await expect(page.getByLabel("Indicadores de pacientes").getByText("Pacientes atendidos")).toBeVisible();
  await expect(page.getByLabel("Indicadores de pacientes").getByText("Retención")).toBeVisible();
  await expect(page.getByRole("img", { name: /nuevos y recurrentes por día/i })).toBeVisible();
  await expect(page.getByRole("list", { name: "Leyenda" })).toContainText("Nuevos");

  await tabs.getByRole("link", { name: "Canales" }).click();
  const channels = page.getByRole("table", { name: "Canales del período" });
  await expect(channels.getByRole("rowheader")).toHaveText(["Agente de WhatsApp", "Panel", "Teléfono", "Presencial", "Web", "Total"]);

  // La sucursal del reporte es la del panel (también cambia el subtítulo).
  await page.getByRole("combobox", { name: "Sucursal" }).last().selectOption({ label: "Heredia" });
  await expect(page.locator(".page-subtitle")).toContainText("Sucursal: Heredia");
  await expect(page).toHaveURL(/\/panel\/reports\/channels\?days=7$/);
});

test("Inicio completo (Pro): cobrado hoy, nuevos, alertas, en riesgo e ingresos de 14 días; Básico sigue con el básico", async ({ page }) => {
  await login(page, "duena@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  const kpis = page.getByRole("region", { name: "Indicadores del día" });
  for (const label of ["Cobrado hoy", "Pacientes nuevos hoy", "Citas de hoy", "No asistieron hoy"]) await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  await expect(heading(page, "Ingresos de los últimos 14 días", 2)).toBeVisible();
  await expect(page.getByRole("img", { name: /Neto cobrado por día en los últimos 14 días/ })).toBeVisible();
  await expect(heading(page, "Para atender", 2)).toBeVisible();
  await expect(page.getByRole("link", { name: /Sin confirmar mañana/ })).toBeVisible();
  const risk = page.getByRole("list", { name: "Pacientes que hace tiempo no vienen" });
  await expect(risk.getByRole("link").first()).toBeVisible();
  // Las tarjetas del Inicio básico siguen abajo.
  await expect(heading(page, "Próximas citas", 2)).toBeVisible();

  await page.goto("/panel/login");
  await page.evaluate(() => sessionStorage.clear());
  await login(page, "basico@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(heading(page, "Citas de hoy", 2)).toBeVisible();
  await expect(page.getByText("Cobrado hoy")).toHaveCount(0);
  await page.goto("/panel/reports/staff");
  await expect(heading(page, "Reportes")).toBeVisible();
  await expect(page.getByText("Disponible en el plan Pro")).toBeVisible();
});

test("recepción: sin Reportes en el menú (y por URL vuelve al Inicio), pero con el Inicio completo de su sucursal", async ({ page }) => {
  await login(page, "recepcion@demo.test");
  const nav = page.getByRole("navigation", { name: "Principal" });
  await expect(nav.getByRole("link", { name: "Reportes" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Indicadores del día" }).getByText("Cobrado hoy")).toBeVisible();
  await page.goto("/panel/reports");
  await expect(page).toHaveURL(/\/panel\/?$/);
});

test("superadmin: Métricas de producto con activación y uso por negocio, y la actividad de un negocio", async ({ page }) => {
  await page.goto("/panel/admin/login");
  await page.getByLabel("Usuario", { exact: true }).fill("admin");
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByLabel("Código", { exact: true }).fill(TOTP_CODE);
  await page.getByRole("button", { name: "Verificar y entrar" }).click();
  await expect(heading(page, "Negocios")).toBeVisible();

  await page.getByRole("navigation", { name: "Superadmin" }).getByRole("link", { name: "Métricas" }).click();
  await expect(page).toHaveURL(/\/panel\/admin\/metrics$/);
  await expect(heading(page, "Métricas de producto")).toBeVisible();
  const activation = page.getByLabel("Activación");
  for (const label of ["Negocios", "Con actividad", "Con citas en la última semana", "Agente encendido", "Activados"]) {
    await expect(activation.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Uso del período").getByText("Conversaciones del agente")).toBeVisible();
  await expect(page.getByRole("img", { name: /Negocios con actividad por día/ })).toBeVisible();
  const table = page.getByRole("table", { name: "Uso por negocio" });
  const dental = table.getByRole("row").filter({ hasText: "Clínica Dental Sonrisa" });
  await expect(dental).toContainText("Encendido");
  await page.getByRole("radio", { name: "7 días" }).check();
  await expect(page.getByRole("img", { name: /Negocios con actividad por día/ })).toBeVisible();

  await dental.getByRole("link", { name: "Clínica Dental Sonrisa" }).click();
  await expect(heading(page, "Clínica Dental Sonrisa")).toBeVisible();
  const activity = page.getByRole("region", { name: "Actividad de los últimos 30 días" });
  await expect(activity).toContainText("Citas creadas");
  await expect(activity).toContainText("Activado");
  await expect(activity.getByRole("img", { name: /Citas creadas por día/ })).toBeVisible();
});

test("móvil (375 px): Reportes, sus pestañas y el Inicio completo sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await expect(page.getByRole("region", { name: "Indicadores del día" })).toBeVisible();
  expect(await noHorizontalScroll(), "/panel").toBe(true);
  for (const path of ["/panel/reports", "/panel/reports/services", "/panel/reports/staff", "/panel/reports/clients", "/panel/reports/channels"]) {
    await page.goto(path);
    await expect(heading(page, "Reportes")).toBeVisible();
    await expect(page.locator(".spinner")).toHaveCount(0);
    expect(await noHorizontalScroll(), path).toBe(true);
  }
});
