import { test, expect } from "@playwright/test";
import { E2E_DB } from "./constantes";
import { vigilarConsola } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Landing pública (/, /privacidad, /terminos, /contrato) + rutas públicas del server
// (/robots.txt, /favicon.svg, /salud, verificación del webhook, 404/405).
// ─────────────────────────────────────────────────────────────────────────────

const PAGINAS = ["/", "/privacidad", "/terminos", "/contrato"];

for (const ruta of PAGINAS) {
  test(`landing ${ruta}: carga sin errores, con CSP y todos sus links internos responden`, async ({ page, request }) => {
    const errores = vigilarConsola(page);
    const fallidas: string[] = [];
    page.on("response", (r) => {
      if (r.url().startsWith(E2E_DB.baseURL) && r.status() >= 400) fallidas.push(`${r.status()} ${r.url()}`);
    });
    const res = await page.goto(ruta);
    expect(res?.status()).toBe(200);
    expect(res?.headers()["content-security-policy"]).toBeTruthy();
    expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
    await expect(page.locator("body")).not.toBeEmpty();

    // Todas las imágenes cargaron (naturalWidth > 0).
    const rotas = await page.$$eval("img", (imgs) =>
      imgs.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0).map((i) => (i as HTMLImageElement).src),
    );
    expect(rotas, "imágenes rotas").toEqual([]);

    // Links internos (no anclas, no externos): cada uno responde 200.
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    const internos = [...new Set(hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//")).map((h) => h.split("#")[0] || "/"))];
    for (const h of internos) {
      const r = await request.get(h);
      expect(r.status(), `link ${h} en ${ruta}`).toBe(200);
    }
    // Anclas #id: el destino existe en ESTA página (o en "/" si es "/#...").
    for (const h of hrefs.filter((x) => x.startsWith("#") && x.length > 1)) {
      await expect(page.locator(h), `ancla ${h} en ${ruta}`).toHaveCount(1);
    }
    // Links externos de contacto: todos van al WhatsApp real de ventas, con texto.
    for (const h of hrefs.filter((x) => x.startsWith("http"))) {
      expect(h, `link externo en ${ruta}`).toMatch(/^https:\/\/wa\.me\/50683658231\?text=/);
    }
    expect(fallidas, fallidas.join("\n")).toEqual([]);
    expect(errores, errores.join("\n")).toEqual([]);
  });
}

test("landing: navegación por anclas del menú y FAQ desplegable", async ({ page }) => {
  await page.goto("/");
  for (const [texto, id] of [
    ["Productos", "#productos"],
    ["Agente WhatsApp", "#agente"],
    ["Cómo funciona", "#como"],
    ["Precios", "#precios"],
  ] as const) {
    await page.locator(".nav-enlaces").getByRole("link", { name: texto, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${id}$`));
    await expect(page.locator(id)).toBeInViewport();
  }
  // FAQ: cada <details> abre y cierra.
  const faqs = page.locator("details");
  const n = await faqs.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const d = faqs.nth(i);
    await d.locator("summary").click();
    await expect(d).toHaveAttribute("open", "");
    await d.locator("summary").click();
    await expect(d).not.toHaveAttribute("open", "");
  }
});

test("landing móvil: el menú hamburguesa abre, cierra y se cierra al tocar un enlace", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const burger = page.locator(".nav-burger");
  await expect(burger).toBeVisible();
  await expect(burger).toHaveAttribute("aria-expanded", "false");
  await burger.click();
  await expect(page.locator(".cabecera")).toHaveClass(/nav-abierta/);
  await expect(burger).toHaveAttribute("aria-expanded", "true");
  await expect(burger).toHaveAttribute("aria-label", "Cerrar menú");
  await page.locator(".nav-enlaces").getByRole("link", { name: "Precios" }).click();
  await expect(page.locator(".cabecera")).not.toHaveClass(/nav-abierta/);
  await expect(burger).toHaveAttribute("aria-expanded", "false");
  // Sin scroll horizontal en móvil.
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(ancho, "scroll horizontal en la landing móvil").toBeLessThanOrEqual(1);
});

test("rutas públicas: robots, favicon, salud, 404 y 405", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /panel");

  const fav = await request.get("/favicon.svg");
  expect(fav.status()).toBe(200);
  expect(fav.headers()["content-type"]).toContain("image/svg+xml");

  const salud = await request.get("/salud");
  expect(salud.status()).toBe(200);
  expect(await salud.text()).toContain("corriendo");
  const detalle = await request.get("/salud?detalle=1");
  const d = await detalle.json();
  expect(d.db.ok).toBe(true);
  expect(d.tenants.fuente).toBe("db");
  expect(d.vigilancia, "la vigilancia no debe exponerse sin token").toBeUndefined();

  expect((await request.get("/no-existe")).status()).toBe(404);
  expect((await request.get("/landing/../package.json")).status()).toBe(404);
  expect((await request.get("/landing/no-existe.png")).status()).toBe(404);
  expect((await request.post("/", { headers: { origin: E2E_DB.baseURL } })).status()).toBe(405);
  expect((await request.post("/robots.txt")).status()).toBe(405);
  expect((await request.post("/panel", { headers: { origin: E2E_DB.baseURL } })).status()).toBe(405);
});

test("webhook: verificación de Meta (token bueno → challenge, malo → 403) y firma inválida → 401", async ({ request }) => {
  const ok = await request.get(`/webhook?hub.mode=subscribe&hub.verify_token=${E2E_DB.verifyToken}&hub.challenge=12345`);
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toBe("12345");
  const malo = await request.get("/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1");
  expect(malo.status()).toBe(403);
  const sinFirma = await request.post("/webhook", { data: { entry: [] } });
  expect(sinFirma.status()).toBe(401);
  const firmaMala = await request.post("/webhook", {
    headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64), "content-type": "application/json" },
    data: JSON.stringify({ entry: [] }),
  });
  expect(firmaMala.status()).toBe(401);
  expect((await request.put("/webhook")).status()).toBe(405);
});
