import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de WhatsApp IA (I2) contra la API simulada (proyecto "panel-mock"): bandeja (lista →
// chat → tomar control → responder → devolver → atendida), historial paginado con fotos y
// audios, ventana de 24 h cerrada y reapertura con plantilla, búsqueda y "Ver más",
// métricas, configuración del agente y números guardados, la tarjeta del Inicio, móvil a
// 375 px, permisos por rol y plan, y el push que falla sin romper (en dev no hay service
// worker). Datos: web/src/modules/whatsapp/whatsappMock.ts sobre los pacientes de la clínica.
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
const inbox = (page: Page) => page.getByRole("region", { name: "Conversaciones", exact: true });
const chat = (page: Page) => page.getByRole("region", { name: "Conversación", exact: true });
const row = (page: Page, name: string) => inbox(page).getByRole("link", { name: new RegExp(name) });

test("bandeja: lista → chat → tomar control → responder → devolver → atendida", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "WhatsApp IA", exact: true }).click();
  await expect(page).toHaveURL(/\/panel\/whatsapp$/);
  await expect(heading(page, "WhatsApp IA")).toBeVisible();
  await expect(page).toHaveTitle("Bandeja · WhatsApp IA · Selyon CRM");
  await expect(chat(page).getByText("Elegí una conversación")).toBeVisible();

  // Primero, la que espera a una persona (modo persona y lo último lo escribió el cliente).
  const links = inbox(page).getByRole("link");
  await expect(links.first()).toContainText("María Fernández");
  await expect(links.first()).toContainText("Espera respuesta");
  await expect(row(page, "Laura Chaves").getByLabel("1 sin leer")).toBeVisible();

  await row(page, "Laura Chaves").click();
  await expect(page).toHaveURL(/\/panel\/whatsapp\/conversations\/[0-9a-f-]{36}$/);
  await expect(chat(page).getByRole("heading", { name: "Laura Chaves" })).toBeVisible();
  await expect(chat(page).getByText("Lo atiende el agente")).toBeVisible();
  await expect(chat(page).getByRole("log").getByText("El jueves a las 2:30 me sirve")).toBeVisible();
  await expect(chat(page).getByRole("textbox")).toHaveCount(0);
  // Al abrirla queda leída.
  await expect(row(page, "Laura Chaves").getByLabel("1 sin leer")).toHaveCount(0);

  await chat(page).getByRole("button", { name: "Tomar control" }).click();
  await expect(page.getByText("Tomaste el control")).toBeVisible();
  const composer = chat(page).getByRole("textbox", { name: "Mensaje para Laura Chaves" });
  await expect(composer).toBeFocused();
  await composer.fill("Hola Laura, soy Daniela de la clínica. ¿Te queda bien el jueves?");
  await composer.press("Enter");
  await expect(chat(page).getByRole("log").getByText("Hola Laura, soy Daniela de la clínica. ¿Te queda bien el jueves?")).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(row(page, "Laura Chaves")).toContainText("Hola Laura, soy Daniela");
  await expect(row(page, "Laura Chaves")).toContainText("Persona");

  await chat(page).getByRole("button", { name: "Devolver al agente" }).click();
  await expect(chat(page).getByText("Lo atiende el agente")).toBeVisible();
  await expect(chat(page).getByRole("textbox")).toHaveCount(0);

  // Atendida: sale de "Abiertas" y aparece en "Atendidas".
  await chat(page).getByRole("button", { name: "Marcar atendida" }).click();
  await expect(page.getByText("Conversación marcada como atendida.")).toBeVisible();
  await expect(row(page, "Laura Chaves")).toHaveCount(0);
  await inbox(page).getByRole("button", { name: "Atendidas" }).click();
  await expect(page).toHaveURL(/status=attended/);
  await expect(row(page, "Laura Chaves")).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "Marcar como abierta" })).toBeVisible();

  // La ficha del paciente, a un clic.
  await chat(page).getByRole("link", { name: "Ver ficha del paciente" }).click();
  await expect(page).toHaveURL(/\/panel\/clients\/[0-9a-f-]{36}$/);
  await expect(heading(page, "Laura Chaves")).toBeVisible();
});

test("chat: historial paginado hacia atrás, fotos y audios", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await row(page, "Valeria Quesada").click();
  const messages = chat(page).locator(".wa-msg");
  await expect(messages).toHaveCount(20);
  await chat(page).getByRole("button", { name: "Ver mensajes anteriores" }).click();
  await expect(messages).toHaveCount(40);
  await chat(page).getByRole("button", { name: "Ver mensajes anteriores" }).click();
  await expect(messages).toHaveCount(45);
  await expect(chat(page).getByRole("button", { name: "Ver mensajes anteriores" })).toHaveCount(0);
  await expect(chat(page).getByText("Hola, tengo varias preguntas antes de agendar")).toBeAttached();

  await row(page, "Sofía Zúñiga").click();
  await expect(chat(page).getByRole("heading", { name: "Sofía Zúñiga" })).toBeVisible();
  await expect(chat(page).getByRole("img", { name: "Foto del cliente" })).toBeVisible();
  await expect(chat(page).locator("audio")).toHaveCount(1);
  await expect(chat(page).getByText("Perfecto, muchas gracias, cualquier cosa le aviso")).toBeVisible();
});

test("ventana de 24 h cerrada: reabrir con plantilla y el cliente responde", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await row(page, "Andrea Méndez").click();
  await expect(chat(page).getByText("Ventana de 24 h cerrada")).toBeVisible();
  await expect(chat(page).getByText("Pasaron más de 24 horas desde el último mensaje del cliente.")).toBeVisible();
  await expect(chat(page).getByRole("textbox")).toHaveCount(0);

  await chat(page).getByRole("button", { name: "Reabrir con plantilla" }).click();
  await expect(page.getByText("Le mandamos la plantilla.", { exact: false })).toBeVisible();
  await expect(chat(page).getByText(/Plantilla «reapertura_conversacion»/)).toBeVisible();
  // El cliente contesta (simulado) y el refresco del chat lo trae: ya se puede escribir.
  await expect(chat(page).getByText("¡Hola! Sí, todavía me interesa.")).toBeVisible({ timeout: 20_000 });
  await expect(chat(page).getByRole("textbox", { name: "Mensaje para Andrea Méndez" })).toBeVisible();
});

test("bandeja: filtros, búsqueda y Ver más", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await inbox(page).getByRole("button", { name: "Todas" }).click();
  await expect(page).toHaveURL(/status=all/);
  const links = inbox(page).getByRole("link");
  await expect(links).toHaveCount(15);
  await inbox(page).getByRole("button", { name: "Ver más" }).click();
  await expect(links).toHaveCount(30);
  await expect(inbox(page).getByRole("button", { name: "Ver más" })).toHaveCount(0);

  await inbox(page).getByLabel("Buscar conversaciones").fill("valeria");
  await expect(page).toHaveURL(/q=valeria/);
  await expect(links.first()).toContainText("Valeria");
  for (const text of await links.allTextContents()) expect(text).toContain("Valeria");

  // El filtro y la búsqueda sobreviven a abrir una conversación y volver.
  await links.first().click();
  await expect(page).toHaveURL(/conversations\/.+\?status=all&q=valeria/);

  await inbox(page).getByLabel("Buscar conversaciones").fill("nadie-se-llama-asi");
  await expect(inbox(page).getByText("No encontramos conversaciones con «nadie-se-llama-asi»")).toBeVisible();
  await inbox(page).getByRole("button", { name: "Ver todas" }).click();
  await expect(links.first()).toBeVisible();
});

test("métricas: KPIs, gráfico por día con tabla y cambio de período", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await page.getByRole("navigation", { name: "Secciones de WhatsApp IA" }).getByRole("link", { name: "Métricas" }).click();
  await expect(page).toHaveURL(/\/panel\/whatsapp\/metrics$/);
  await expect(page).toHaveTitle("Métricas · WhatsApp IA · Selyon CRM");
  await expect(page.locator(".wa-kpi-label")).toHaveText([
    "Conversaciones",
    "Resueltas sin una persona",
    "Citas agendadas por el agente",
    "Pasadas a una persona",
    "Costo de la IA",
  ]);
  const chart = page.getByRole("img", { name: /Conversaciones y citas agendadas por el agente por día/ });
  await expect(chart).toBeVisible();
  await expect(page.locator(".wa-chart-bookings")).toHaveCount(30);

  await page.getByRole("button", { name: "7 días" }).click();
  await expect(page.getByRole("button", { name: "7 días" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".wa-chart-bookings")).toHaveCount(7);
  await page.getByText("Ver los datos en una tabla").click();
  await expect(page.locator(".wa-chart-table tbody tr")).toHaveCount(7);

  // El detalle de un día también con el teclado.
  await chart.focus();
  await page.keyboard.press("End");
  await expect(page.locator(".wa-chart-tooltip")).toBeVisible();
  await expect(page.locator(".wa-chart-tooltip")).toContainText(/conversaci/);
});

test("configuración del agente: tono, conocimiento y FAQ guardados; números", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp/settings");
  await expect(page).toHaveTitle("Configuración · WhatsApp IA · Selyon CRM");

  await page.getByLabel("Tono", { exact: true }).fill("Amable y directo");
  await page.getByLabel("Trato al cliente").selectOption("usted");
  await page.getByRole("button", { name: "Agregar dato a Precios" }).click();
  await expect(page.getByRole("textbox", { name: "Dato 3 de Precios", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Dato 3 de Precios", exact: true }).fill("Blanqueamiento: ₡120 000");
  await page.getByRole("button", { name: "Agregar pregunta" }).click();
  await expect(page.getByLabel("Pregunta 2", { exact: true })).toBeFocused();
  await page.getByLabel("Pregunta 2", { exact: true }).fill("¿Atienden niños?");

  // Una pregunta sin respuesta no se guarda.
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Escribí la respuesta.")).toBeVisible();
  await page.getByLabel("Respuesta 2", { exact: true }).fill("Sí, desde los 3 años.");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Tono", { exact: true })).toHaveValue("Amable y directo");
  await expect(page.getByLabel("Trato al cliente")).toHaveValue("usted");
  await expect(page.getByRole("textbox", { name: "Dato 3 de Precios", exact: true })).toHaveValue("Blanqueamiento: ₡120 000");
  await expect(page.getByLabel("Respuesta 2", { exact: true })).toHaveValue("Sí, desde los 3 años.");

  // Números: probar, plantillas (con validación) y conectar uno nuevo.
  const channel = page.getByRole("form", { name: "Número +506 4000 1234" });
  await channel.getByRole("button", { name: "Probar conexión" }).click();
  await expect(page.getByText("La conexión del +506 4000 1234 funciona.")).toBeVisible();
  await channel.getByLabel("Plantilla de marketing").fill("Promo Mayo");
  await channel.getByRole("button", { name: "Guardar número" }).click();
  await expect(channel.getByText(/Usá el nombre exacto de la plantilla/)).toBeVisible();
  await channel.getByLabel("Plantilla de marketing").fill("promo_mayo");
  await channel.getByRole("button", { name: "Guardar número" }).click();
  await expect(page.getByText("Guardamos los cambios del +506 4000 1234.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Número +506 4000 5678" }).getByText("Acceso vencido")).toBeVisible();

  await page.getByRole("button", { name: "Conectar un número" }).click();
  await expect(page.getByText("Número conectado.", { exact: false })).toBeVisible();
  await expect(page.getByRole("form", { name: /^Número \+506/ })).toHaveCount(3);
});

test("Inicio: conversaciones esperando con acceso a la bandeja", async ({ page }) => {
  await login(page, "duena@demo.test");
  const card = page.getByRole("region", { name: "Conversaciones esperando" });
  await expect(card.locator(".home-big")).toHaveText("1");
  await expect(card).toContainText("Una conversación espera que alguien del equipo responda.");
  await card.getByRole("link", { name: "Ir a la bandeja" }).click();
  await expect(page).toHaveURL(/\/panel\/whatsapp$/);
});

test("móvil (375 px): lista → chat → volver, sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  await page.goto("/panel/whatsapp");
  await expect(inbox(page)).toBeVisible();
  await expect(chat(page)).toBeHidden();
  await row(page, "Sofía Zúñiga").click();
  await expect(chat(page).getByRole("heading", { name: "Sofía Zúñiga" })).toBeVisible();
  await expect(inbox(page)).toBeHidden();
  await expect(chat(page).getByRole("button", { name: "Tomar control" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await chat(page).getByRole("link", { name: "Volver a la bandeja" }).click();
  await expect(page).toHaveURL(/\/panel\/whatsapp$/);
  await expect(inbox(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.goto("/panel/whatsapp/metrics");
  await expect(page.getByRole("img", { name: /por día/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.goto("/panel/whatsapp/settings");
  await expect(page.getByLabel("Tono", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("permisos: recepción sin Configuración del agente; Pro sin agente no entra", async ({ page }) => {
  await login(page, "recepcion@demo.test");
  await page.goto("/panel/whatsapp/settings");
  await expect(page).toHaveURL(/\/panel\/whatsapp$/);
  await expect(page.getByRole("navigation", { name: "Secciones de WhatsApp IA" }).getByRole("link")).toHaveText(["Bandeja", "Métricas"]);
  await page.getByRole("navigation", { name: "Secciones de WhatsApp IA" }).getByRole("link", { name: "Métricas" }).click();
  await expect(page.locator(".wa-kpi-label")).not.toContainText(["Costo de la IA"]);

  await page.goto("/panel/login");
  await page.evaluate(() => sessionStorage.clear());
  await login(page, "sinagente@demo.test");
  await page.goto("/panel/whatsapp/metrics");
  await expect(page).not.toHaveURL(/whatsapp/);
});

test("push: el botón aparece y, sin service worker (dev), falla con un aviso y sin romper", async ({ page }) => {
  // Chromium headless arranca con las notificaciones bloqueadas: el menú lo dice.
  await login(page, "duena@demo.test");
  await page.getByRole("button", { name: "Menú de Daniela Mora" }).click();
  await expect(page.getByRole("menuitem", { name: /Notificaciones bloqueadas/ })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // Con el permiso "sin decidir" se ofrece activarlas (menú y bandeja).
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "default" });
    Notification.requestPermission = async () => "granted";
  });
  await page.goto("/panel/whatsapp");
  await page.getByRole("button", { name: "Menú de Daniela Mora" }).click();
  await expect(page.getByRole("menuitem", { name: "Activar notificaciones" })).toBeVisible();
  await page.keyboard.press("Escape");
  await inbox(page).getByRole("button", { name: "Activar notificaciones" }).click();
  await expect(page.getByText(/No pudimos preparar las notificaciones/)).toBeVisible();
  await expect(inbox(page).getByRole("link").first()).toBeVisible();
});
