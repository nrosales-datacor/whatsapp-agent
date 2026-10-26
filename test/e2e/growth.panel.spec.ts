import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del crecimiento (I6.1–I6.4) contra la API simulada (proyecto "panel-mock"): Campañas
// (candado del Básico, borrador → vista previa → lanzar → resultados, programar y cancelar),
// WhatsApp IA › Crecimiento (guardar en el Pro, candado en el Básico, aviso de plantillas),
// las plantillas nuevas de los números, promociones en la ficha del cliente, la sección de
// crecimiento de las métricas y de Configuración › Plan, y móvil sin scroll horizontal.
// Datos: web/src/modules/{campaigns,clients,whatsapp}/*Mock.ts.
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

async function newDraft(page: Page, name: string, message: string) {
  await page.goto("/panel/campaigns");
  await page.getByRole("button", { name: "Nueva campaña" }).first().click();
  await expect(heading(page, "Nueva campaña")).toBeVisible();
  await page.getByLabel("Nombre de la campaña").fill(name);
  await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill(message);
}

test("Campañas: el Básico la ve con candado", async ({ page }) => {
  await login(page, "basico@demo.test");
  await page.goto("/panel/campaigns");
  await expect(page.getByText("Disponible en el plan Pro").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Nueva campaña" })).toHaveCount(0);
});

test("Campañas: el Pro arranca vacío, con su cartera de promociones", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Campañas", exact: true }).click();
  await expect(page).toHaveURL(/\/panel\/campaigns$/);
  await expect(heading(page, "Campañas")).toBeVisible();
  await expect(page.getByText("Todavía no hay campañas")).toBeVisible();
  await expect(page.getByLabel("Promociones en tu cartera")).toContainText("aceptaron recibir promociones");
});

test("Campañas: borrador con segmento y vista previa → lanzar → resultados", async ({ page }) => {
  await login(page, "duena@demo.test");
  await newDraft(page, "Limpieza de octubre", "Este mes la limpieza va con 20% de descuento.");
  // Un solo párrafo: los saltos de línea se reemplazan por espacios.
  const message = page.getByRole("textbox", { name: "Mensaje", exact: true });
  await message.press("End");
  await message.pressSequentially("\nAgendá por acá.");
  await expect(message).toHaveValue("Este mes la limpieza va con 20% de descuento. Agendá por acá.");
  await expect(page.getByText(/\/ 900/)).toBeVisible();

  const preview = page.getByRole("complementary", { name: "Vista previa" });
  await expect(preview.getByText(/la reciben \(de \d+ que cumplen los filtros\)/)).toBeVisible();
  await expect(preview.getByLabel("Quedan afuera")).toContainText("sin aceptar promociones");
  await expect(preview.getByText(/pidieron la baja/)).toBeVisible();
  const before = Number(await preview.locator(".cp-preview-number").textContent());

  // Filtro por estado: la vista previa se recalcula.
  await page.getByRole("button", { name: "Activo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Activo", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Number(await preview.locator(".cp-preview-number").textContent())).toBeLessThan(before);

  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page).toHaveURL(/\/panel\/campaigns\/[^/]+$/);
  await expect(heading(page, "Limpieza de octubre")).toBeVisible();
  await expect(page.getByText("Borrador", { exact: true })).toBeVisible();
  await expect(page.getByText(/A quiénes:.*Activo/)).toBeVisible();

  // Editar el borrador y volver.
  await page.getByRole("link", { name: "Editar" }).click();
  await expect(heading(page, "Editar campaña")).toBeVisible();
  await page.getByRole("button", { name: "Activo", exact: true }).click();
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByText("Todos los que aceptaron promociones", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Lanzar" }).click();
  const dialog = page.getByRole("dialog", { name: "Lanzar la campaña" });
  await dialog.getByRole("button", { name: "Mandar ahora" }).click();
  await expect(page.getByText("Campaña lanzada", { exact: false })).toBeVisible();
  // El mock manda de a uno; el detalle se refresca solo hasta quedar enviada.
  await expect(page.locator(".page-actions .cp-status")).toHaveText("Enviada", { timeout: 25_000 });
  const results = page.getByRole("list", { name: "Resultados" });
  for (const label of ["Destinatarios", "Enviadas", "Respondieron"]) await expect(results.getByText(label, { exact: true })).toBeVisible();
  await expect(results.getByText(/agendadas$/)).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lanzar" })).toHaveCount(0);

  await page.getByRole("link", { name: "Volver a Campañas" }).click();
  await expect(page.getByRole("list", { name: "Campañas" }).getByRole("link", { name: /Limpieza de octubre/ })).toContainText("enviadas");
});

test("Campañas: programar y cancelar; borrar un borrador", async ({ page }) => {
  await login(page, "duena@demo.test");
  await newDraft(page, "Promo de diciembre", "Regalá una limpieza en Navidad.");
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(heading(page, "Promo de diciembre")).toBeVisible();

  await page.getByRole("button", { name: "Lanzar" }).click();
  const dialog = page.getByRole("dialog", { name: "Lanzar la campaña" });
  await dialog.getByLabel("Programarla").check();
  await dialog.getByLabel("Día").fill(crDate(3));
  await dialog.getByLabel("Hora", { exact: true }).fill("10:30");
  await dialog.getByRole("button", { name: "Programar" }).click();
  await expect(page.getByText("Campaña programada.")).toBeVisible();
  await expect(page.getByText("Programada", { exact: true })).toBeVisible();
  await expect(page.getByText(/Programada para el/)).toBeVisible();

  await page.getByRole("button", { name: "Cancelar campaña" }).click();
  await page.getByRole("dialog", { name: "¿Cancelar la campaña?" }).getByRole("button", { name: "Sí, cancelar" }).click();
  await expect(page.getByText("Cancelada", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancelar campaña" })).toHaveCount(0);
  await expect(page.getByRole("table").getByText(/Campaña cancelada/).first()).toBeVisible();

  await newDraft(page, "Borrador descartable", "Hola.");
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(heading(page, "Borrador descartable")).toBeVisible();
  await page.getByRole("button", { name: "Borrar" }).click();
  await page.getByRole("dialog", { name: "¿Borrar el borrador?" }).getByRole("button", { name: "Sí, borrar" }).click();
  await expect(page).toHaveURL(/\/panel\/campaigns$/);
  await expect(page.getByRole("link", { name: /Borrador descartable/ })).toHaveCount(0);
});

test("WhatsApp IA › Crecimiento: el Pro guarda reseñas y sugerencias; la plantilla de seguimiento quita el aviso", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await page.getByRole("navigation", { name: "Secciones de WhatsApp IA" }).getByRole("link", { name: "Crecimiento" }).click();
  await expect(page).toHaveURL(/\/panel\/whatsapp\/growth$/);
  await expect(page).toHaveTitle("Crecimiento · WhatsApp IA · Selyon CRM");

  const reviews = page.getByRole("region", { name: "Reseñas" });
  await expect(reviews.getByText(/Falta la plantilla de seguimiento post-servicio/)).toBeVisible();
  await reviews.getByLabel("Pedir la opinión después de cada cita").check();
  await reviews.getByLabel("Horas después de terminar").fill("4");
  await reviews.getByLabel("Link para dejar una reseña").fill("ftp://mal");
  await reviews.getByRole("button", { name: "Guardar" }).click();
  await expect(reviews.getByText(/empieza con https/)).toBeVisible();
  await reviews.getByLabel("Link para dejar una reseña").fill("https://g.page/r/clinica/review");
  await reviews.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Guardamos el seguimiento post-servicio.")).toBeVisible();

  const upsell = page.getByRole("region", { name: "Sugerencias al agendar" });
  await upsell.getByLabel("Ofrecer un servicio complementario al agendar").check();
  await upsell.getByRole("button", { name: "Agregar regla" }).click();
  const from = upsell.getByLabel("A quien agenda (regla 1)");
  const to = upsell.getByLabel("Ofrecerle");
  const options = await from.locator("option").allTextContents();
  await from.selectOption({ label: options[1] });
  await to.selectOption({ label: options[1] });
  await upsell.getByRole("button", { name: "Guardar" }).click();
  await expect(upsell.getByText("Elegí un servicio distinto al que se agenda.")).toBeVisible();
  await to.selectOption({ label: options[2] });
  await upsell.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Guardamos las sugerencias al agendar.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Reseñas" }).getByLabel("Horas después de terminar")).toHaveValue("4");
  await expect(page.getByRole("region", { name: "Sugerencias al agendar" }).getByLabel("A quien agenda (regla 1)")).toBeVisible();

  // Números: la plantilla de seguimiento (y su idioma) en el número principal.
  await page.goto("/panel/whatsapp/settings");
  const channel = page.getByRole("form", { name: "Número +506 4000 1234" });
  await expect(channel.getByLabel("Plantilla de rescate de cotizaciones")).toBeVisible();
  await channel.getByLabel("Plantilla de seguimiento post-servicio").fill("seguimiento_servicio");
  await channel.getByLabel("Idioma de las plantillas").fill("es_MX");
  await channel.getByRole("button", { name: "Guardar número" }).click();
  await expect(page.getByText("Guardamos los cambios del +506 4000 1234.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Número +506 4000 1234" }).getByLabel("Idioma de las plantillas")).toHaveValue("es_MX");

  await page.goto("/panel/whatsapp/growth");
  await expect(page.getByRole("region", { name: "Reseñas" }).getByText(/Falta la plantilla de seguimiento/)).toHaveCount(0);
});

test("WhatsApp IA › Crecimiento: el Básico ve todo con candado", async ({ page }) => {
  await login(page, "basico@demo.test");
  await page.goto("/panel/whatsapp/growth");
  await expect(page.getByText("Disponible en el plan Pro")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Guardar" })).toHaveCount(0);
  await expect(page.getByLabel("Pedir la opinión después de cada cita")).toBeDisabled();
});

test("WhatsApp IA › Crecimiento: recepción no tiene la pestaña", async ({ page }) => {
  await login(page, "recepcion@demo.test");
  await page.goto("/panel/whatsapp");
  await expect(page.getByRole("navigation", { name: "Secciones de WhatsApp IA" }).getByRole("link", { name: "Crecimiento" })).toHaveCount(0);
  await page.goto("/panel/whatsapp/growth");
  await expect(page).toHaveURL(/\/panel\/whatsapp$/);
});

test("Ficha del cliente: promociones sin respuesta → acepta → baja, con confirmación", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/clients/c1000000-0000-4000-8000-000000000004");
  const section = page.getByRole("region", { name: "Promociones" });
  await expect(section.getByText(/Sin respuesta/)).toBeVisible();
  await section.getByRole("button", { name: "Registrar que acepta" }).click();
  await page.getByRole("dialog", { name: "¿Acepta recibir promociones?" }).getByRole("button", { name: "Sí, acepta" }).click();
  await expect(page.getByText("Registramos que acepta recibir promociones.")).toBeVisible();
  await expect(section.getByText(/Acepta promociones desde el/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Registrar que acepta" })).toHaveCount(0);

  await section.getByRole("button", { name: "Registrar baja" }).click();
  await page.getByRole("dialog", { name: "¿Registrar la baja de promociones?" }).getByRole("button", { name: "Registrar baja" }).click();
  await expect(section.getByText(/Pidió la baja de promociones el/)).toBeVisible();
});

test("Métricas y Plan: la sección de crecimiento del Pro", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp/metrics");
  const growth = page.getByRole("region", { name: "Crecimiento" });
  for (const label of ["Seguimientos post-servicio", "Reseñas pedidas", "Cotizaciones sin agendar", "Cotizaciones recuperadas"]) {
    await expect(growth.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(growth.getByText(/agendados después del rescate/)).toBeVisible();

  await page.goto("/panel/settings/plan");
  await expect(page.getByText(/Reseñas: después de cada cita/)).toBeVisible();
  await expect(page.getByText(/Rescate de cotizaciones: a quien preguntó un precio/)).toBeVisible();
  await expect(page.getByText(/Sugerencias al agendar: el agente ofrece/)).toBeVisible();
});

test("móvil (375 px): Campañas, el editor y Crecimiento sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  for (const [path, title] of [
    ["/panel/campaigns", "Campañas"],
    ["/panel/campaigns/new", "Nueva campaña"],
    ["/panel/whatsapp/growth", "WhatsApp IA"],
  ] as const) {
    await page.goto(path);
    await expect(heading(page, title)).toBeVisible();
    expect(await noHorizontalScroll(), path).toBe(true);
  }
});
