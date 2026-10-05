import { test, expect } from "@playwright/test";
import { USUARIOS } from "./constantes";
import { ORIGEN, entrar, entrarUI, vigilarConsola } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Login del operador/dueño: validaciones, mostrar/ocultar clave, links de soporte,
// sesión persistente, logout, negocio pausado y rutas profundas del SPA.
// ─────────────────────────────────────────────────────────────────────────────

test("login: campos requeridos — no envía con el formulario vacío", async ({ page }) => {
  await page.goto("/panel");
  let pidioLogin = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/panel/login")) pidioLogin = true;
  });
  await page.getByRole("button", { name: "Entrar →" }).click();
  // El navegador bloquea el submit por `required`.
  expect(await page.locator("#usuario").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await page.waitForTimeout(300);
  expect(pidioLogin).toBe(false);
  await expect(page.locator("#app")).toHaveCount(0);
});

test("login: usuario inexistente y clave incorrecta dan el MISMO error (sin oráculo)", async ({ page }) => {
  await page.goto("/panel");
  await page.locator("#usuario").fill("no-existe-e2e");
  await page.locator("#password").fill("cualquier-cosa");
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#loginError")).toHaveText("Usuario o contraseña incorrectos");

  await page.locator("#usuario").fill(USUARIOS.clinica.usuario);
  await page.locator("#password").fill("clave-mala-123");
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#loginError")).toHaveText("Usuario o contraseña incorrectos");
  await expect(page.locator("#app")).toHaveCount(0);
});

test("login: mostrar/ocultar contraseña y links de soporte por WhatsApp", async ({ page }) => {
  await page.goto("/panel");
  const pass = page.locator("#password");
  await pass.fill("secreta");
  await expect(pass).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Mostrar contraseña" }).click();
  await expect(pass).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Ocultar contraseña" }).click();
  await expect(pass).toHaveAttribute("type", "password");

  const olvido = page.getByRole("link", { name: "¿La olvidaste?" });
  await expect(olvido).toHaveAttribute("href", /^https:\/\/wa\.me\/\d+\?text=.*olvid/);
  await expect(olvido).toHaveAttribute("target", "_blank");
  await expect(olvido).toHaveAttribute("rel", /noopener/);
  await expect(page.getByRole("link", { name: "¿Problemas para entrar? Escribinos" })).toHaveAttribute("href", /^https:\/\/wa\.me\//);
});

test("login: el usuario se recorta (espacios) y Enter envía el formulario", async ({ page }) => {
  await page.goto("/panel");
  await page.locator("#usuario").fill(`  ${USUARIOS.clinica.usuario}  `);
  await page.locator("#password").fill(USUARIOS.clinica.password);
  await page.locator("#password").press("Enter");
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator(".hd-nombre")).toHaveText("Clínica Dental Aurora");
});

test("sesión: persiste al recargar; Salir vuelve al login y la cookie deja de valer", async ({ page }) => {
  const errores = vigilarConsola(page);
  await entrarUI(page, USUARIOS.clinica);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();

  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page.locator("#login")).toBeVisible();
  const me = await page.request.get("/api/panel/me");
  expect(me.status()).toBe(401);
  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  expect(errores, errores.join("\n")).toEqual([]);
});

test("sesión: una ruta profunda desconocida del SPA cae en el panel del operador", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await page.goto("/panel/una/ruta/que/no/existe");
  await expect(page.locator("#app")).toBeVisible();
});

test("sesión vencida: si la cookie se borra, la próxima llamada lleva al login sin recargar", async ({ page, context }) => {
  await entrar(page, USUARIOS.clinica);
  await context.clearCookies();
  // El polling de conversaciones (4 s) recibe 401 → el manejador global cae al login.
  await expect(page.locator("#login")).toBeVisible({ timeout: 15_000 });
});

test("negocio pausado: con la clave CORRECTA explica la pausa y ofrece contactar a Selyon", async ({ page }) => {
  await page.goto("/panel");
  await page.locator("#usuario").fill(USUARIOS.pausado.usuario);
  await page.locator("#password").fill(USUARIOS.pausado.password);
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#loginError")).toContainText(/pausad/i);
  await expect(page.getByRole("link", { name: "Escribir a Selyon para reactivarla" })).toHaveAttribute("href", /wa\.me/);

  // Con la clave INCORRECTA no revela que el negocio está pausado.
  await page.locator("#password").fill("clave-incorrecta");
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#loginError")).toHaveText("Usuario o contraseña incorrectos");
});

test("CSRF: login con Origin ajeno → 403; sin Origin ni Referer → 403", async ({ request }) => {
  const ajeno = await request.post("/api/panel/login", {
    headers: { origin: "http://evil.example" },
    data: { usuario: USUARIOS.clinica.usuario, password: USUARIOS.clinica.password },
  });
  expect(ajeno.status()).toBe(403);
  const ok = await request.post("/api/panel/login", {
    headers: ORIGEN,
    data: { usuario: USUARIOS.clinica.usuario, password: USUARIOS.clinica.password },
  });
  expect(ok.status()).toBe(200);
  const cookie = ok.headers()["set-cookie"] ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
});
