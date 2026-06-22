#!/usr/bin/env node
/*
 * shotPanel.mjs — captura el panel (SPA) en sus distintas vistas, logueándose
 * primero. La verify.mjs del skill solo abre una URL; este panel es una sola
 * página con login/bandeja/chat/ficha/dashboard alternados por JS, así que hay
 * que manejar el login y navegar la UI.
 *
 * Uso: node scripts/shotPanel.mjs <baseUrl> --out <dir> [--label before]
 */
import "dotenv/config";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const base = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://localhost:3100";
const outDir = resolve(arg("--out", "./design-shots"));
const label = arg("--label", "before");
// La contraseña NO se hardcodea: se lee del entorno (.env). Así no queda en git.
const USUARIO = process.env.PANEL_DEMO_USUARIO || "lavacar-rosales";
const PASSWORD = process.env.PANEL_DEMO_PASSWORD;
if (!PASSWORD) {
  console.error("Falta PANEL_DEMO_PASSWORD (contraseña del panel para el login de las capturas). Ponela en .env.");
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const VIEWPORTS = [
  { name: "mobile", w: 390, h: 844 },
  { name: "desktop", w: 1440, h: 900 },
];

const browser = await chromium.launch();
const shot = async (page, view, vp) => {
  const file = resolve(outDir, `${label}-${view}-${vp.name}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
};

try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    await page.goto(`${base}/panel`, { waitUntil: "networkidle", timeout: 30000 });

    // 1) LOGIN
    await page.waitForSelector("#loginForm", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(page, "login", vp);

    // Autenticarse
    await page.fill("#usuario", USUARIO);
    await page.fill("#password", PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector(".conv", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(500);

    // El panel es una SPA: navegamos llamando sus funciones globales (los clicks
    // fallan en móvil porque #chat es position:fixed y tapa la lista — un bug del
    // diseño actual que el rediseño corrige).
    const isMobile = vp.w <= 760;

    // 2) BANDEJA (lista). En móvil, el estado "viendo la lista" es #chat.escondido.
    if (isMobile) await page.evaluate(() => document.querySelector("#chat").classList.add("escondido"));
    await page.waitForTimeout(200);
    await shot(page, "inbox", vp);

    // 3) CHAT (abrir la conversación más reciente = Diego)
    const firstId = await page.getAttribute(".conv", "data-id");
    await page.evaluate(async (id) => { await abrir(id); }, firstId);
    await page.waitForSelector("#msgs .b", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(500);
    await shot(page, "chat", vp);

    // 4) FICHA DEL CLIENTE (modal)
    await page.evaluate(async () => { await abrirFicha(); });
    await page.waitForSelector("#fichaOverlay", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(page, "ficha", vp);
    await page.evaluate(() => document.querySelector("#fichaOverlay").classList.add("oculto"));
    await page.waitForTimeout(300);

    // 5) DASHBOARD
    await page.evaluate(async () => { await abrirDashboard(); });
    await page.waitForSelector("#dashboard.activo .barra", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(500);
    // El dashboard es position:fixed con scroll interno; lo pasamos a flujo normal
    // y ocultamos lo demás para capturarlo completo con fullPage.
    await page.evaluate(() => {
      const d = document.querySelector("#dashboard");
      d.style.position = "static";
      d.style.height = "auto";
      document.querySelector("#app").style.display = "none";
      const l = document.querySelector("#login"); if (l) l.style.display = "none";
    });
    await page.waitForTimeout(300);
    const dashFile = resolve(outDir, `${label}-dashboard-${vp.name}.png`);
    await page.screenshot({ path: dashFile, fullPage: true });
    console.log(`saved ${dashFile}`);

    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log("\nListo. Abrí los PNG y critícalos contra el checklist de web-design.");
