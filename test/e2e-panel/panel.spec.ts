import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./constantes";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del panel por la UI real (Chromium), contra el server en memoria + Graph
// mockeado (ver servidor.ts). Formaliza lo que antes se verificaba a mano con
// shotPanel.mjs. Cada test arranca con un contexto limpio (sin cookie) y se loguea.
// ─────────────────────────────────────────────────────────────────────────────

async function entrar(page: Page) {
  await page.goto("/panel");
  await page.locator("#usuario").fill(E2E.usuario);
  await page.locator("#password").fill(E2E.password);
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#app")).toBeVisible();
}

test("login: credenciales incorrectas muestran error y no entran", async ({ page }) => {
  await page.goto("/panel");
  await page.locator("#usuario").fill(E2E.usuario);
  await page.locator("#password").fill("clave-incorrecta");
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#loginError")).toContainText(/incorrect/i);
  await expect(page.locator("#app")).toHaveCount(0);
});

test("login → bandeja con conversaciones sembradas", async ({ page }) => {
  await entrar(page);
  await expect(page.locator("#lista")).toBeVisible();
  // La demo siembra 16 conversaciones.
  await expect(page.locator("#convs .conv").first()).toBeVisible();
  expect(await page.locator("#convs .conv").count()).toBeGreaterThan(5);
});

test("abrir conversación → mensajes → ficha del cliente → dashboard", async ({ page }) => {
  await entrar(page);
  await page.locator("#convs .conv").first().click();
  await expect(page.locator("#chatTitulo")).toBeVisible();
  await expect(page.locator("#msgs .b").first()).toBeVisible();

  // Ficha del cliente (modal).
  await page.locator(".chatHead").click();
  await expect(page.locator(".ficha-modal")).toBeVisible();
  await page.locator(".ficha-modal .ficha-head button").click();
  await expect(page.locator(".ficha-modal")).toHaveCount(0);

  // Dashboard (pestaña "Panel").
  await page.getByRole("button", { name: "Panel" }).click();
  await expect(page.locator(".kpi").first()).toBeVisible();
});

test("toggle bot ↔ humano en una conversación", async ({ page }) => {
  await entrar(page);
  await page.locator("#convs .conv").first().click();
  await expect(page.locator("#chatTitulo")).toBeVisible();

  const atenderYo = page.getByRole("button", { name: "Atender yo" });
  const devolver = page.getByRole("button", { name: "Devolver al bot" });

  // Puede arrancar en bot o humano según la conversación; normalizamos a bot primero.
  if (await devolver.isVisible().catch(() => false)) {
    await devolver.click();
  }
  await expect(atenderYo).toBeVisible();
  await atenderYo.click();
  await expect(devolver).toBeVisible();
  await expect(page.locator(".chatHead .pill.humano")).toBeVisible();
  await devolver.click();
  await expect(atenderYo).toBeVisible();
});

test("marcar atendido y reabrir", async ({ page }) => {
  await entrar(page);
  await page.locator("#convs .conv").first().click();
  await expect(page.locator("#chatTitulo")).toBeVisible();

  const atendido = page.getByRole("button", { name: "Atendido" });
  const reabrir = page.getByRole("button", { name: "Reabrir" });
  if (await reabrir.isVisible().catch(() => false)) {
    await reabrir.click();
  }
  await atendido.click();
  await expect(reabrir).toBeVisible();
  await reabrir.click();
  await expect(atendido).toBeVisible();
});

test("responder: el mensaje del operador aparece en el chat (Graph mockeado)", async ({ page }) => {
  await entrar(page);
  await page.locator("#convs .conv").first().click();
  await expect(page.locator("#msgs .b").first()).toBeVisible();

  const antes = await page.locator("#msgs .b").count();
  const texto = "Mensaje de prueba del operador E2E";
  await page.locator("#composer textarea").fill(texto);
  await page.locator("#composer button").click();

  await expect(page.locator("#msgs")).toContainText(texto);
  expect(await page.locator("#msgs .b").count()).toBeGreaterThan(antes);
  // Al responder un humano, la conversación pasa a modo humano.
  await expect(page.locator(".chatHead .pill.humano")).toBeVisible();
});

test("agenda: la vista carga y el modal de nueva cita se abre", async ({ page }) => {
  await entrar(page);
  await page.getByRole("button", { name: "Agenda" }).click();
  await expect(page.locator("#agenda")).toBeVisible();
  await page.getByRole("button", { name: "Nueva cita" }).click();
  await expect(page.locator("#agendaForm")).toBeVisible();
  // El selector de servicio viene poblado con los servicios agendables del tenant.
  await expect(page.locator("#aServicio option")).not.toHaveCount(0);
});

for (const vp of [
  { nombre: "móvil", width: 390, height: 844 },
  { nombre: "desktop", width: 1440, height: 900 },
]) {
  test(`responsivo ${vp.nombre} + tema claro/oscuro sin errores de consola`, async ({ page }) => {
    const errores: string[] = [];
    // Ruido de red/PWA que no son bugs de la app: no deben tumbar el test.
    const benigno = /favicon|manifest|service worker|Failed to load resource|net::ERR/i;
    page.on("pageerror", (e) => errores.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !benigno.test(m.text())) errores.push("console: " + m.text());
    });

    await page.setViewportSize({ width: vp.width, height: vp.height });
    await entrar(page);
    await expect(page.locator("#appHeader")).toBeVisible();

    const html = page.locator("html");
    const temaInicial = await html.getAttribute("data-tema");
    await page.getByRole("button", { name: "Alternar modo claro/oscuro" }).click();
    await expect(html).not.toHaveAttribute("data-tema", temaInicial ?? "claro");

    expect(errores, errores.join("\n")).toEqual([]);
  });
}
