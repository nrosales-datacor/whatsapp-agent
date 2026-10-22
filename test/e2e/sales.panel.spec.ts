import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de Ventas y Comisiones (I4) contra la API simulada (proyecto "panel-mock"): cobrar
// desde la cita de la Agenda (seña y pago, con el saldo a la vista y el tope del saldo),
// Pendientes (cobrar desde ahí), Cobros ("+ Nuevo → Cobro" suelto y una devolución con
// motivo), Resumen del día, Comisiones (regla, liquidar y marcar pagada), "Mis comisiones"
// del profesional, Recepción sin comisiones, Configuración › Métodos de pago y móvil sin
// scroll horizontal. Datos de web/src/modules/sales/salesMock.ts (cobra parte de las citas
// completadas sembradas por la Agenda simulada).
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";

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

/** El próximo lunes a 7+ días (fuera de las citas sembradas; la Dra. Ruiz atiende en Escazú). */
function freeMonday(): string {
  for (let i = 7; i < 14; i++) {
    const date = crDate(i);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
  }
  throw new Error("sin lunes");
}

/** Monto con cualquier separador de miles ("₡10 000" con espacio fino o normal). */
const amount = (digits: string) => new RegExp(digits.replace(/(\d)(?=(\d{3})+$)/g, "$1\\s?"));

test("cobrar desde la cita: seña y pago con el saldo a la vista, sin pasarse del saldo", async ({ page }) => {
  await login(page, "duena@demo.test");
  const monday = freeMonday();
  await page.goto(`/panel/agenda?date=${monday}`);
  await page.getByRole("button", { name: "Nueva cita" }).click();
  const create = page.getByRole("dialog", { name: "Nueva cita" });
  await create.getByLabel("Buscar paciente").fill("María Fernández");
  await create.getByRole("button", { name: /María Fernández/ }).first().click();
  await create.getByRole("checkbox", { name: /Limpieza dental/ }).check();
  await create.getByRole("radiogroup", { name: "Horarios disponibles" }).getByRole("radio").first().click();
  await create.getByRole("button", { name: "Agendar cita" }).click();
  await expect(create).toBeHidden();

  await page.getByRole("button", { name: /María Fernández, Limpieza dental, Sin confirmar/ }).click();
  const drawer = page.getByRole("dialog", { name: "María Fernández" });
  const balance = drawer.getByRole("region", { name: "Cobro de la cita" });
  await expect(balance.getByText("Saldo")).toBeVisible();
  await expect(balance.getByText("Cobrado")).toBeVisible();

  // Seña.
  await balance.getByRole("button", { name: "Cobrar" }).click();
  const charge = page.getByRole("dialog", { name: "Cobrar cita" });
  await expect(charge.getByRole("group", { name: "Tipo" })).toBeVisible();
  await charge.getByLabel(/Seña/).check();
  const total = (await charge.getByLabel(/Monto/).inputValue()).replace(/\D/g, "");
  await charge.getByLabel(/Monto/).fill(`${Number(total) + 1}`);
  await charge.getByRole("button", { name: "Registrar seña" }).click();
  await expect(charge.getByText(/El monto supera el saldo/)).toBeVisible();
  await charge.getByLabel(/Monto/).fill("10000");
  await charge.getByLabel("Método de pago").selectOption({ label: "SINPE Móvil" });
  await charge.getByRole("button", { name: "Registrar seña" }).click();
  await expect(charge).toBeHidden();
  await expect(page.getByText(/Seña registrada: .*10\s?000 \(SINPE Móvil\)\. Saldo:/)).toBeVisible();
  await expect(balance.locator(".sales-balance > div").first()).toContainText(amount("10000"));

  // Pago del resto: el monto arranca en el saldo.
  await balance.getByRole("button", { name: "Cobrar" }).click();
  await expect(charge.getByLabel(/Monto/)).toHaveValue(`${Number(total) - 10000}`);
  await charge.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByText(/Cobro registrado: .* Quedó pagada\./)).toBeVisible();
  await expect(balance.getByRole("button", { name: "Cobrar" })).toHaveCount(0);
});

test("Pendientes: las completadas con saldo, y cobrar desde ahí", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/sales/pending");
  await expect(heading(page, "Ventas")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pendientes" })).toHaveAttribute("aria-current", "page");
  const list = page.getByRole("list", { name: "Pendientes de cobro" });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const before = await list.getByRole("listitem").count();
  await list.getByRole("button", { name: /^Cobrar/ }).first().click();
  const charge = page.getByRole("dialog", { name: "Cobrar cita" });
  // Completada: sin opción de seña.
  await expect(charge.getByRole("group", { name: "Tipo" })).toHaveCount(0);
  await charge.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByText(/Quedó pagada\./)).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(before - 1);
});

test('Cobros: "+ Nuevo → Cobro" suelto, devolución con motivo y el resumen del día', async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("button", { name: "Nuevo" }).click();
  await page.getByRole("menuitem", { name: /Cobro/ }).click();
  await expect(page).toHaveURL(/\/panel\/sales\?new=1/);
  const dialog = page.getByRole("dialog", { name: "Nuevo cobro" });
  await dialog.getByRole("button", { name: "Registrar cobro" }).click();
  await expect(dialog.getByText("Elegí el paciente.")).toBeVisible();
  await dialog.getByLabel("Buscar paciente").fill("María");
  await dialog.getByRole("button", { name: /María Fernández/ }).first().click();
  await dialog.getByLabel(/Monto/).fill("5000");
  await dialog.getByRole("button", { name: "Registrar cobro" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Cobro registrado: .*5\s?000 de María Fernández\./)).toBeVisible();

  const table = page.getByRole("table", { name: "Movimientos" });
  const row = table.getByRole("row").filter({ hasText: "María Fernández" }).filter({ hasText: "Sin cita" }).first();
  await expect(row).toContainText(amount("5000"));
  await row.getByRole("button", { name: /^Devolver/ }).click();
  const refund = page.getByRole("dialog", { name: "Devolver un pago" });
  await refund.getByLabel(/Monto a devolver/).fill("2000");
  await refund.getByRole("button", { name: "Registrar devolución" }).click();
  await expect(refund.getByText("Contanos el motivo (queda en el historial).")).toBeVisible();
  await refund.getByLabel("Motivo").fill("Se cobró de más");
  await refund.getByRole("button", { name: "Registrar devolución" }).click();
  await expect(refund).toBeHidden();
  await expect(page.getByText(/Devolución registrada: .*2\s?000 a María Fernández\./)).toBeVisible();
  await expect(table.getByRole("row").filter({ hasText: "Se cobró de más" })).toContainText("Devolución");

  // Resumen del día: por método, con los movimientos del día e imprimible.
  await page.getByRole("link", { name: "Resumen del día" }).click();
  await expect(heading(page, /^Resumen del /, 2)).toBeVisible();
  const byMethod = page.getByRole("table", { name: "Resumen por método de pago" });
  for (const name of ["Efectivo", "SINPE Móvil", "Tarjeta", "Transferencia"]) await expect(byMethod.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole("region", { name: "Movimientos del día" })).toContainText("Devolución · María Fernández · Efectivo");
  await expect(page.getByRole("button", { name: "Imprimir" })).toBeEnabled();
});

test("Comisiones: regla nueva, liquidar a un profesional y marcar la liquidación pagada", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/sales/commissions");
  await expect(page.getByRole("link", { name: "Comisiones", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Desde").first().fill(crDate(-10));

  // Regla por servicio (la general del 10 % ya está).
  const rules = page.getByRole("region", { name: "Reglas de comisión" });
  await expect(rules.getByRole("list", { name: "Reglas de comisión" })).toContainText("Todos los servicios");
  await rules.getByRole("button", { name: "Nueva regla" }).click();
  const ruleDialog = page.getByRole("dialog", { name: "Nueva regla de comisión" });
  await ruleDialog.getByLabel("Se aplica a").selectOption({ label: "Servicio" });
  await ruleDialog.getByLabel("Porcentaje (%)").fill("15");
  await ruleDialog.getByRole("button", { name: "Guardar" }).click();
  await expect(ruleDialog).toBeHidden();
  await expect(rules.getByRole("list", { name: "Reglas de comisión" })).toContainText("Servicio · 15 %");
  // Una segunda regla general choca.
  await rules.getByRole("button", { name: "Nueva regla" }).click();
  await ruleDialog.getByLabel("Porcentaje (%)").fill("5");
  await ruleDialog.getByRole("button", { name: "Guardar" }).click();
  await expect(ruleDialog.getByText(/Ya hay una regla para ese alcance/)).toBeVisible();
  await ruleDialog.getByRole("button", { name: "Cancelar" }).click();

  // Liquidar al primero con comisiones sin liquidar.
  const byStaff = page.getByRole("table", { name: "Comisiones por profesional" });
  await byStaff.getByRole("button", { name: /^Liquidar/ }).first().click();
  const payout = page.getByRole("dialog", { name: /^Liquidar a / });
  await payout.getByRole("button", { name: "Crear liquidación" }).click();
  await expect(page.getByText(/Liquidación de .* creada\./)).toBeVisible();
  const payouts = page.getByRole("list", { name: "Liquidaciones" });
  await expect(payouts).toContainText("Sin pagar");
  await payouts.getByRole("button", { name: /^Marcar pagada/ }).first().click();
  await expect(page.getByText(/marcada como pagada/)).toBeVisible();
  await expect(payouts.getByText("Pagada", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Movimientos de comisión" })).toBeVisible();
});

test("profesional: Mis comisiones (solo lo suyo, sin reglas); recepción: Ventas sin comisiones", async ({ page }) => {
  await login(page, "profesional@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Mis comisiones" }).click();
  await expect(page).toHaveURL(/\/panel\/sales\/commissions$/);
  await expect(heading(page, "Mis comisiones")).toBeVisible();
  await expect(page.getByRole("region", { name: "Movimientos", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Liquidaciones", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Reglas de comisión" })).toHaveCount(0);
  await expect(page.getByRole("table", { name: /Comisiones por/ })).toHaveCount(0);
  for (const staff of await page.getByRole("list", { name: "Movimientos de comisión" }).getByRole("listitem").allTextContents()) {
    expect(staff).not.toContain("Dra. Carmen Ruiz");
  }

  await page.goto("/panel/login");
  await page.evaluate(() => sessionStorage.clear());
  await login(page, "recepcion@demo.test");
  await page.goto("/panel/sales");
  await expect(heading(page, "Ventas")).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Secciones de Ventas" });
  await expect(tabs.getByRole("link")).toHaveText(["Cobros", "Pendientes", "Resumen del día"]);
  await page.goto("/panel/sales/commissions");
  await expect(page).toHaveURL(/\/panel\/sales$/);
  // Recepción cobra, pero no devuelve.
  await expect(page.getByRole("button", { name: "Nuevo cobro" })).toBeVisible();
  await expect(page.locator(".spinner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Devolver/ })).toHaveCount(0);
});

test("Configuración › Métodos de pago: alta y baja en Pro", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/settings/payment-methods");
  await expect(heading(page, "Métodos de pago", 2)).toBeVisible();
  const list = page.getByRole("list", { name: "Métodos de pago" });
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(list).toContainText("SINPE Móvil");
  await page.getByRole("button", { name: "Nuevo método" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo método de pago" });
  await dialog.getByLabel("Nombre").fill("Vale de regalo");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await page.getByRole("button", { name: "Subir Vale de regalo" }).click();
  await expect(list.getByRole("listitem").nth(3)).toContainText("Vale de regalo");
  await page.getByRole("button", { name: "Eliminar Vale de regalo" }).click();
  await page.getByRole("dialog", { name: "¿Eliminar Vale de regalo?" }).getByRole("button", { name: "Eliminar" }).click();
  await expect(page.getByText("«Vale de regalo» quedó eliminado.")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(4);
});

test("móvil (375 px): Cobros, Pendientes y el resumen del día sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  for (const path of ["/panel/sales", "/panel/sales/pending", "/panel/sales/today", "/panel/sales/commissions"]) {
    await page.goto(path);
    await expect(heading(page, "Ventas")).toBeVisible();
    await expect(page.locator(".spinner")).toHaveCount(0);
    expect(await noHorizontalScroll(), path).toBe(true);
  }
});
