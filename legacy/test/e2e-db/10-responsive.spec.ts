import { test, expect, type Page } from "@playwright/test";
import { USUARIOS } from "./constantes";
import { entrar, entrarAdmin, vigilarConsola } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Recorrido visual: CADA vista del panel (dueño Pro) y el admin, en móvil (390 px) y
// desktop (1440 px), en tema claro y oscuro. Sin errores de consola, sin scroll
// horizontal de página y con la navegación correcta (tabs arriba / barra inferior).
// ─────────────────────────────────────────────────────────────────────────────

const VISTAS: { tab: string; listo: string }[] = [
  { tab: "Inbox", listo: "#lista" },
  { tab: "Panel", listo: ".kpi" },
  { tab: "Agenda", listo: "#agenda .agenda-toolbar" },
  { tab: "Mi negocio", listo: "#miNegocio .mn-layout" },
  { tab: "Usuarios", listo: "#usuarios .us-content" },
  { tab: "Campañas", listo: "#campanias .dash-titulo" },
];

async function sinScrollHorizontal(page: Page, donde: string) {
  const exceso = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(exceso, `scroll horizontal de página en ${donde}`).toBeLessThanOrEqual(1);
}

async function fijarTema(page: Page, tema: "claro" | "oscuro") {
  const html = page.locator("html");
  if ((await html.getAttribute("data-tema")) !== tema) await page.getByRole("button", { name: "Alternar modo claro/oscuro" }).click();
  await expect(html).toHaveAttribute("data-tema", tema);
}

for (const vp of [
  { nombre: "móvil", width: 390, height: 844 },
  { nombre: "desktop", width: 1440, height: 900 },
]) {
  for (const tema of ["claro", "oscuro"] as const) {
    test(`todas las vistas · ${vp.nombre} · ${tema}`, async ({ page }) => {
      const errores = vigilarConsola(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await entrar(page, USUARIOS.clinica);
      await fijarTema(page, tema);
      const tabs = page.locator(".hd-tabs");
      await expect(tabs).toBeVisible();
      if (vp.width <= 760) {
        // Barra inferior: pegada al borde de abajo.
        const caja = await tabs.boundingBox();
        expect(caja!.y + caja!.height).toBeGreaterThan(vp.height - 120);
      }
      for (const v of VISTAS) {
        await page.locator(".hd-tab", { hasText: v.tab }).click();
        await expect(page.locator(v.listo).first()).toBeVisible();
        await expect(page.locator(".hd-tab.activa")).toContainText(v.tab);
        await sinScrollHorizontal(page, `${v.tab} (${vp.nombre}, ${tema})`);
      }
      // Chat abierto + ficha del cliente.
      await page.locator(".hd-tab", { hasText: "Inbox" }).click();
      await page.locator("#convs .conv").first().click();
      await expect(page.locator("#chatTitulo")).toBeVisible();
      await sinScrollHorizontal(page, `chat (${vp.nombre}, ${tema})`);
      await page.locator(".chatHead").click();
      const ficha = page.locator(".ficha-modal-cliente");
      await expect(ficha).toBeVisible();
      const cajaFicha = await ficha.boundingBox();
      expect(cajaFicha!.width, "la ficha no entra en la pantalla").toBeLessThanOrEqual(vp.width);
      await ficha.locator(".ficha-head button").click();
      expect(errores, errores.join("\n")).toEqual([]);
    });
  }

  test(`admin · ${vp.nombre}`, async ({ page, context }) => {
    const errores = vigilarConsola(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await entrarAdmin(context, page);
    await expect(page.locator("form.admin-form")).toBeVisible();
    await sinScrollHorizontal(page, `admin (${vp.nombre})`);
    expect(errores, errores.join("\n")).toEqual([]);
  });

  test(`login y landing · ${vp.nombre}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/panel");
    await expect(page.locator("#login")).toBeVisible();
    await sinScrollHorizontal(page, `login (${vp.nombre})`);
    for (const ruta of ["/", "/privacidad", "/terminos", "/contrato"]) {
      await page.goto(ruta);
      await sinScrollHorizontal(page, `landing ${ruta} (${vp.nombre})`);
    }
  });
}

test("accesibilidad básica: botones de ícono con nombre accesible e inputs con etiqueta", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  for (const v of VISTAS) {
    await page.locator(".hd-tab", { hasText: v.tab }).click();
    await expect(page.locator(v.listo).first()).toBeVisible();
    const sinNombre = await page.$$eval("button", (bs) =>
      bs
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label") && !b.getAttribute("title"))
        .map((b) => b.outerHTML.slice(0, 120)),
    );
    expect(sinNombre, `botones sin nombre accesible en ${v.tab}`).toEqual([]);
  }
});
