import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { USUARIOS } from "./constantes";
import { apiComo, entrar, enviados, esperarToast } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas (C3.2, Pro, solo dueño): resumen de consentimiento, segmentos con vista
// previa, validaciones, borrador, detalle, envío real (el worker manda la plantilla por
// Graph mockeado SOLO a quien dio permiso), programación y cancelación.
// ─────────────────────────────────────────────────────────────────────────────

let api: APIRequestContext;
let original: Record<string, unknown>;

test.beforeAll(async ({ playwright }) => {
  api = await apiComo(playwright, USUARIOS.clinica);
  original = await (await api.get("/api/panel/config")).json();
});
test.afterAll(async () => {
  await api.post("/api/panel/config", { data: original });
});

async function setPlantilla(nombre: string) {
  const cfg = await (await api.get("/api/panel/config")).json();
  const r = await api.post("/api/panel/config", { data: { ...cfg, plantillaMarketing: nombre } });
  expect(r.status(), await r.text()).toBe(200);
}

async function abrirCampanias(page: Page) {
  await page.locator(".hd-tab", { hasText: "Campañas" }).click();
  await expect(page.locator("#campanias h2")).toHaveText("Campañas");
}

async function crearBorrador(page: Page, nombre: string, mensaje = "Promo E2E: 20% esta semana") {
  await page.locator("#campNombre").fill(nombre);
  await page.locator("#campMensaje").fill(mensaje);
  await page.getByRole("button", { name: "Crear como borrador" }).click();
  await esperarToast(page, "Campaña creada como borrador");
  await expect(page.locator("#campanias tbody tr", { hasText: nombre })).toBeVisible();
}

test("resumen de permisos y vista previa de cada tipo de segmento", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await expect(page.locator(".card", { hasText: "Permiso de promociones" })).toContainText(/\d+ de \d+ clientes? dieron permiso/);

  const tipo = page.getByTitle("Tipo de segmento");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.locator(".card", { hasText: "Nueva campaña" }).locator(".campo-ayuda").last()).toContainText(/La campaña llegaría a \d+ cliente|Ningún cliente con permiso/);

  await tipo.selectOption("inactivos");
  await expect(page.getByPlaceholder("días")).toHaveValue("60");
  await page.getByPlaceholder("días").fill("1");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText(/llegaría a|Ningún cliente con permiso/)).toBeVisible();

  await tipo.selectOption("servicio_antiguo");
  const servicio = page.getByTitle("Servicio", { exact: true });
  await expect(servicio.locator("option")).not.toHaveCount(1);
  await servicio.selectOption({ label: "Limpieza dental" });
  await page.getByPlaceholder("meses").fill("0");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText(/llegaría a|Ningún cliente con permiso/)).toBeVisible();
  // Cambiar el filtro limpia la vista previa vieja.
  await page.getByPlaceholder("meses").fill("3");
  await expect(page.getByText(/llegaría a|Ningún cliente con permiso/)).toHaveCount(0);
});

test("validaciones al crear: nombre, mensaje (contador y tope de 300) y servicio obligatorio", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  const crear = page.getByRole("button", { name: "Crear como borrador" });
  await crear.click();
  await esperarToast(page, "Nombre inválido");
  await page.locator("#campNombre").fill("Sin mensaje");
  await crear.click();
  await esperarToast(page, "Mensaje inválido");
  await page.locator("#campMensaje").fill("x".repeat(350));
  await expect(page.locator("#campMensaje")).toHaveValue("x".repeat(300)); // maxLength
  await expect(page.locator("label[for=campMensaje]")).toContainText("(300/300)");
  await page.getByTitle("Tipo de segmento").selectOption("servicio_antiguo");
  await crear.click();
  await esperarToast(page, "Elegí un servicio para este segmento");
});

test("borrador → detalle → 'Enviar ahora' sin plantilla de marketing → error claro", async ({ page }) => {
  await setPlantilla("");
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await crearBorrador(page, "Sin plantilla E2E");
  await page.locator("#campanias tbody tr", { hasText: "Sin plantilla E2E" }).getByRole("button", { name: "Ver detalle" }).click();
  const modal = page.locator(".ficha-modal");
  await expect(modal.locator(".ficha-head h3")).toHaveText("Sin plantilla E2E");
  await expect(modal.locator(".badge-estado")).toHaveText("Borrador");
  await modal.getByRole("button", { name: "Enviar ahora" }).click();
  await esperarToast(page, 'Configurá la plantilla de marketing en "Mi negocio"');
  await modal.locator(".ficha-head button").click();
  await expect(modal).toHaveCount(0);
});

test("envío real: solo a clientes con permiso, la campaña se completa y la plantilla llega por Graph", async ({ page }) => {
  await setPlantilla("promo_e2e");
  const antes = (await enviados(page.request)).length;
  const consent = await (await api.get("/api/panel/campanias/consentimiento")).json();
  expect(consent.conConsentimiento, "el seed debería tener al menos un cliente con permiso").toBeGreaterThan(0);

  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await crearBorrador(page, "Envío real E2E", "Mensaje de la campaña real E2E");
  await page.locator("#campanias tbody tr", { hasText: "Envío real E2E" }).getByRole("button", { name: "Ver detalle" }).click();
  const modal = page.locator(".ficha-modal");
  await modal.getByRole("button", { name: "Enviar ahora" }).click();
  await esperarToast(page, "Envío en curso");
  await expect(modal.locator(".badge-estado")).toHaveText("Completada", { timeout: 20_000 });
  await expect(modal).toContainText(`Enviados: ${consent.conConsentimiento}`);
  await expect(modal.getByRole("button", { name: "Cancelar campaña" })).toHaveCount(0);

  const nuevos = (await enviados(page.request)).slice(antes).filter((e) => e.plantilla === "promo_e2e");
  expect(nuevos.length).toBe(consent.conConsentimiento);
  expect(nuevos.map((e) => e.to)).toContain("50687123344"); // Diego: el que tiene permiso en el seed
  expect(JSON.stringify(nuevos[0].raw)).toContain("Mensaje de la campaña real E2E");
  // Re-enviar la misma campaña → 400.
  const lista = (await (await api.get("/api/panel/campanias")).json()).campanias as { id: string; nombre: string }[];
  const id = lista.find((c) => c.nombre === "Envío real E2E")!.id;
  expect((await api.post(`/api/panel/campanias/${id}/enviar`, { data: {} })).status()).toBe(400);
});

test("segmento sin destinatarios: confirmar el envío avisa que no hay a quién mandar", async ({ page }) => {
  await setPlantilla("promo_e2e");
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await page.getByTitle("Tipo de segmento").selectOption("inactivos");
  await page.getByPlaceholder("días").fill("3650");
  await crearBorrador(page, "Vacía E2E");
  await page.locator("#campanias tbody tr", { hasText: "Vacía E2E" }).getByRole("button", { name: "Ver detalle" }).click();
  await page.locator(".ficha-modal").getByRole("button", { name: "Enviar ahora" }).click();
  await esperarToast(page, "El segmento no tiene destinatarios");
});

test("programar: fecha pasada deshabilita y avisa; fecha futura → 'Programada'; luego cancelar", async ({ page }) => {
  await setPlantilla("promo_e2e");
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await crearBorrador(page, "Programada E2E");
  await page.locator("#campanias tbody tr", { hasText: "Programada E2E" }).getByRole("button", { name: "Ver detalle" }).click();
  const modal = page.locator(".ficha-modal");
  await modal.locator(".admin-check input").check();
  const boton = modal.getByRole("button", { name: "Programar envío" });
  await expect(boton).toBeDisabled(); // sin fecha
  await modal.locator("#campFechaEnvio").fill("2020-01-01T10:00");
  await expect(modal.getByText("Elegí una fecha futura")).toBeVisible();
  await expect(boton).toBeDisabled();
  const futuro = new Date(Date.now() + 3 * 86_400_000);
  const local = new Date(futuro.getTime() - futuro.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await modal.locator("#campFechaEnvio").fill(local);
  await expect(boton).toBeEnabled();
  await boton.click();
  await esperarToast(page, "Campaña programada");
  await expect(modal.locator(".badge-estado")).toHaveText("Programada");
  await modal.getByRole("button", { name: "Cancelar campaña" }).click();
  await esperarToast(page, "Campaña cancelada");
  await expect(modal.locator(".badge-estado")).toHaveText("Cancelada");
  await page.locator(".overlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#campanias tbody tr", { hasText: "Programada E2E" }).locator(".badge-estado")).toHaveText("Cancelada");
});

test("cancelar un borrador desde el detalle", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirCampanias(page);
  await crearBorrador(page, "Cancelar borrador E2E");
  await page.locator("#campanias tbody tr", { hasText: "Cancelar borrador E2E" }).getByRole("button", { name: "Ver detalle" }).click();
  await page.locator(".ficha-modal").getByRole("button", { name: "Cancelar campaña" }).click();
  await esperarToast(page, "Campaña cancelada");
  await expect(page.locator(".ficha-modal .badge-estado")).toHaveText("Cancelada");
});

test("API campañas: guards (operador 403, plan Básico 403), 404 ajeno y validaciones", async ({ playwright }) => {
  const op = await apiComo(playwright, USUARIOS.clinicaOp);
  expect((await op.get("/api/panel/campanias")).status()).toBe(403);
  const basico = await apiComo(playwright, USUARIOS.basico);
  expect((await basico.get("/api/panel/campanias")).status()).toBe(403);
  const lista = (await (await api.get("/api/panel/campanias")).json()).campanias as { id: string }[];
  expect(lista.length).toBeGreaterThan(0);
  expect((await api.get("/api/panel/campanias/no-existe")).status()).toBe(404);
  expect((await api.get("/api/panel/campanias/segmento/preview?tipo=raro")).status()).toBe(400);
  expect((await api.post("/api/panel/campanias", { data: { nombre: "x", mensaje: "y", segmentoTipo: "servicio_antiguo", servicioId: "no-existe" } })).status()).toBe(400);
  expect((await api.post(`/api/panel/campanias/${lista[0].id}/enviar`, { data: { programadaPara: "no-es-fecha" } })).status()).toBe(400);
});
