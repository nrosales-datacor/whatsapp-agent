import { test, expect } from "@playwright/test";
import { E2E_DB, TENANTS, USUARIOS } from "./constantes";
import { apiComo, entrar, enviados, estadoRed, responderDialogo, vigilarConsola, webhookTexto } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (métricas), estados de error con "Reintentar", gating por plan (pestañas
// 🔒 + modal Pro), avisos de cuota (80% / 100% / tope de IA) con "Mejorar plan",
// notificaciones push y el comportamiento del bot con cuota agotada o negocio pausado.
// ─────────────────────────────────────────────────────────────────────────────

test("dashboard: KPIs, hero de rescate, gráficos y reputación sin valores rotos", async ({ page }) => {
  const errores = vigilarConsola(page);
  await entrar(page, USUARIOS.clinica);
  await page.locator(".hd-tab", { hasText: "Panel" }).click();
  await expect(page.locator("#dashboard h2")).toHaveText("Panel · Clínica Dental Aurora");
  await expect(page.locator(".hero-rescate .hero-monto")).toContainText("₡");
  await expect(page.locator(".kpis .kpi")).toHaveCount(3);
  await expect(page.locator(".kpis-sec .kpi")).toHaveCount(8);
  await expect(page.locator(".card", { hasText: "Citas por día" }).locator(".cd-col").first()).toBeVisible();
  await expect(page.locator(".card", { hasText: "Servicios más pedidos" }).locator(".ranking-row").first()).toBeVisible();
  await expect(page.locator(".card", { hasText: "Horas pico" }).locator(".bv-col").first()).toBeVisible();
  await expect(page.locator(".card", { hasText: "Reputación en Google" }).locator(".reputacion-rating")).toHaveText(/^\d\.\d$/);
  await expect(page.locator(".card", { hasText: "Origen de las citas" }).locator(".split-track")).toBeVisible();
  // Los nombres de servicio vienen resueltos (no ids crudos).
  for (const n of await page.locator(".rank-nombre").allTextContents()) expect(n).not.toMatch(/^[a-z0-9-]+$/);
  const texto = await page.locator("#dashboard").innerText();
  expect(texto).not.toMatch(/NaN|undefined|Infinity|null/);
  expect(errores, errores.join("\n")).toEqual([]);
});

test("estados de error: métricas y bandeja muestran 'Reintentar' y se recuperan", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await page.route("**/api/panel/metricas", (r) => r.fulfill({ status: 500, body: "boom" }));
  await page.locator(".hd-tab", { hasText: "Panel" }).click();
  await expect(page.getByText("No se pudieron cargar las métricas.")).toBeVisible();
  await expect(page.getByText("Tus datos están a salvo")).toBeVisible();
  await page.unroute("**/api/panel/metricas");
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.locator(".kpi").first()).toBeVisible();

  await page.route("**/api/panel/conversaciones", (r) => r.abort());
  await page.locator(".hd-tab", { hasText: "Inbox" }).click();
  await expect(page.getByText("No se pudieron cargar las conversaciones.")).toBeVisible({ timeout: 15_000 });
  await page.unroute("**/api/panel/conversaciones");
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.locator("#convs .conv").first()).toBeVisible();
});

test("plan Básico: Usuarios/Campañas con 🔒 abren el modal 'Función Pro' (cerrar con ✕ y con el fondo)", async ({ page }) => {
  await entrar(page, USUARIOS.basico);
  for (const tab of ["Usuarios", "Campañas"]) {
    const t = page.locator(".hd-tab", { hasText: tab });
    await expect(t).toHaveClass(/hd-tab-bloqueada/);
    await t.click();
    const modal = page.locator(".ficha-modal", { hasText: "Función Pro" });
    await expect(modal).toContainText("Disponible en el plan Pro");
    await expect(page.locator(".hd-tab.activa")).toContainText("Inbox"); // no cambió de vista
    if (tab === "Usuarios") await modal.getByTitle("Cerrar").click();
    else await page.locator(".overlay").click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveCount(0);
  }
  // Sin campañas en el plan, el chat no ofrece "Pedir permiso promos" (aun con ventana abierta).
  await webhookTexto(page.request, { pnid: TENANTS.basico.pnid, clienteWa: "50677770010", texto: "Hola barbería" });
  await page.locator("#convs .conv").first().click({ timeout: 15_000 });
  await expect(page.locator(".pill-ventana.abierta")).toBeVisible();
  await expect(page.getByRole("button", { name: "Agendar cita" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pedir permiso promos" })).toHaveCount(0);
});

test("cuota al 85% (Básico): aviso amarillo cerrable que no vuelve en el mes; 'Mejorar plan' va a WhatsApp", async ({ page }) => {
  await entrar(page, USUARIOS.basico);
  const aviso = page.locator(".aviso-cuota");
  await expect(aviso).toHaveAttribute("role", "status");
  // 425 sembradas (+ las que sumen otras specs que le escriben a este negocio).
  await expect(aviso).toContainText(/Usaste el 8\d% de tu plan \(4\d\d de 500 conversaciones automáticas este mes\)/);
  const mejorar = aviso.getByRole("link", { name: "Mejorar plan" });
  await expect(mejorar).toHaveAttribute("href", new RegExp(`^https://wa\\.me/${E2E_DB.contactoWhatsapp}\\?text=.*Barber`));
  await expect(mejorar).toHaveAttribute("target", "_blank");
  await aviso.getByRole("button", { name: "Cerrar aviso" }).click();
  await expect(aviso).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator(".aviso-cuota")).toHaveCount(0);
});

test("cuota al 100%: aviso rojo SIN cerrar; el operador ve 'Avisale al dueño' y no 'Mejorar plan'", async ({ page, browser }) => {
  await entrar(page, USUARIOS.lleno);
  const aviso = page.locator(".aviso-cuota.aviso-cuota-agotada");
  await expect(aviso).toHaveAttribute("role", "alert");
  await expect(aviso).toContainText("Llegaste al tope de tu plan (500 de 500");
  await expect(aviso.getByRole("button", { name: "Cerrar aviso" })).toHaveCount(0);
  await expect(aviso.getByRole("link", { name: "Mejorar plan" })).toBeVisible();

  const ctx = await browser.newContext({ baseURL: E2E_DB.baseURL });
  const op = await ctx.newPage();
  await entrar(op, USUARIOS.llenoOp);
  await expect(op.locator(".aviso-cuota")).toContainText("Avisale al dueño del negocio.");
  await expect(op.locator(".aviso-cuota").getByRole("link", { name: "Mejorar plan" })).toHaveCount(0);
  await ctx.close();
});

test("tope de gasto de IA agotado: aviso rojo propio", async ({ page }) => {
  await entrar(page, USUARIOS.gastoia);
  await expect(page.locator(".aviso-cuota-agotada")).toContainText("Llegaste al límite de uso de IA de este mes.");
});

test("bot con cuota agotada: NO llama al LLM, avisa al cliente y pasa la conversación a humano", async ({ page, playwright }) => {
  const antes = (await estadoRed(page.request)).llamadasLLM;
  const wa = "50677770001";
  await webhookTexto(page.request, { pnid: TENANTS.lleno.pnid, clienteWa: wa, texto: "Hola, ¿tienen campo?" });
  await expect.poll(async () => (await enviados(page.request)).some((e) => e.to === wa), { timeout: 15_000 }).toBe(true);
  expect((await estadoRed(page.request)).llamadasLLM).toBe(antes);
  const api = await apiComo(playwright, USUARIOS.lleno);
  const conv = ((await (await api.get("/api/panel/conversaciones")).json()).conversaciones as { clienteWa: string; modo: string }[]).find(
    (c) => c.clienteWa === wa,
  );
  expect(conv?.modo).toBe("humano");
});

test("negocio pausado: el mensaje se guarda pero el bot NO responde ni gasta IA", async ({ page }) => {
  const antes = (await estadoRed(page.request)).llamadasLLM;
  const wa = "50677770002";
  await webhookTexto(page.request, { pnid: TENANTS.pausado.pnid, clienteWa: wa, texto: "¿Están abiertos?" });
  await page.waitForTimeout(2500);
  expect((await enviados(page.request)).some((e) => e.to === wa)).toBe(false);
  expect((await estadoRed(page.request)).llamadasLLM).toBe(antes);
});

test("mensaje a un phone_number_id desconocido: 200 a Meta y no se procesa", async ({ page }) => {
  const antes = (await estadoRed(page.request)).llamadasLLM;
  await webhookTexto(page.request, { pnid: "9999999999", clienteWa: "50677770003", texto: "hola" });
  await page.waitForTimeout(1500);
  expect((await estadoRed(page.request)).llamadasLLM).toBe(antes);
});

test("BAJA por WhatsApp: el cliente queda fuera de campañas (opt-out) sin pasar por el bot", async ({ page, playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  const wa = "50677770004";
  await webhookTexto(page.request, { pnid: TENANTS.clinica.pnid, clienteWa: wa, interactiveId: "mktsi", titulo: "Sí" });
  await expect.poll(async () => (await (await api.get("/api/panel/campanias/consentimiento")).json()).conConsentimiento, { timeout: 15_000 }).toBeGreaterThan(0);
  const antes = await (await api.get("/api/panel/campanias/consentimiento")).json();
  const llm = (await estadoRed(page.request)).llamadasLLM;
  await webhookTexto(page.request, { pnid: TENANTS.clinica.pnid, clienteWa: wa, texto: "BAJA" });
  await expect.poll(async () => (await (await api.get("/api/panel/campanias/consentimiento")).json()).conBaja, { timeout: 15_000 }).toBe(antes.conBaja + 1);
  expect((await estadoRed(page.request)).llamadasLLM).toBe(llm);
});

test("notificaciones: la campana aparece; si el navegador las bloquea, avisa cómo activarlas", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  const bell = page.getByRole("button", { name: "Activar notificaciones" });
  await expect(bell).toBeVisible();
  const msg = responderDialogo(page, true);
  await bell.click();
  expect(await msg).toMatch(/bloqueadas|No se pudieron activar/);
});

test("API push: valida el endpoint (anti-SSRF), suscribe, prueba y desuscribe", async ({ playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/e2e-token-123", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  expect((await api.post("/api/panel/push/suscribir", { data: { ...sub, endpoint: "http://169.254.169.254/latest" } })).status()).toBe(400);
  expect((await api.post("/api/panel/push/suscribir", { data: { ...sub, endpoint: "https://evil.example/push" } })).status()).toBe(400);
  const ok = await api.post("/api/panel/push/suscribir", { data: sub });
  expect(ok.status(), await ok.text()).toBe(200);
  const prueba = await (await api.post("/api/panel/push/probar")).json();
  expect(prueba.enviadas + prueba.fallidas).toBeGreaterThanOrEqual(1);
  expect((await api.post("/api/panel/push/desuscribir", { data: { endpoint: sub.endpoint } })).status()).toBe(200);
  const vacia = await (await api.post("/api/panel/push/probar")).json();
  expect(vacia.enviadas).toBe(0);
});

test("tema claro/oscuro: alterna, persiste al recargar y respeta la preferencia", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  const html = page.locator("html");
  const inicial = await html.getAttribute("data-tema");
  await page.getByRole("button", { name: "Alternar modo claro/oscuro" }).click();
  const nuevo = inicial === "oscuro" ? "claro" : "oscuro";
  await expect(html).toHaveAttribute("data-tema", nuevo);
  await page.reload();
  await expect(html).toHaveAttribute("data-tema", nuevo);
  await page.getByRole("button", { name: "Alternar modo claro/oscuro" }).click();
  await expect(html).toHaveAttribute("data-tema", inicial ?? "claro");
});
