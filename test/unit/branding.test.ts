import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCT_NAME as SERVER_PRODUCT_NAME } from "../../src/platform/brand";
import { accentFor, contrastRatio, documentTitle, initials, PRODUCT_NAME, safeLogoUrl } from "../../web/src/lib/branding";

// ─────────────────────────────────────────────────────────────────────────────
// Marca white-label del panel (web/src/lib/branding.ts): el acento del negocio ajustado a
// contraste AA en los dos temas, el filtro del logo (llega del negocio y va a un <img src>)
// y los textos de marca. Sin DOM (applyBranding/resetBranding tocan el documento).
// ─────────────────────────────────────────────────────────────────────────────

/** Espejo de SURFACE_LIGHT / SURFACE_DARK de branding.ts (y de --surface en global.css). */
const SURFACE_LIGHT = "#ffffff";
const SURFACE_DARK = "#16181c";
const AA = 4.5;

test("branding: contrastRatio sigue la fórmula WCAG (1 a 21, simétrica)", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff") * 100) / 100, 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(contrastRatio("#0b6b5e", "#ffffff"), contrastRatio("#ffffff", "#0b6b5e"));
  // #767676 sobre blanco es el gris AA de referencia (≈ 4,54:1).
  assert.ok(Math.abs(contrastRatio("#767676", "#ffffff") - 4.54) < 0.01);
  assert.equal(contrastRatio("#FFFFFF", "#000000"), contrastRatio("#ffffff", "#000000"), "mayúsculas valen");
  // Un color inválido no rompe: contraste mínimo.
  assert.equal(contrastRatio("rojo", "#ffffff"), 1);
  assert.equal(contrastRatio("#fff", "#000000"), 1, "solo #rrggbb");
});

/** Muestra de colores: una grilla del cubo RGB más los casos difíciles (amarillo, blanco, negro, grises). */
function sampleColors(): string[] {
  const levels = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const grid = levels.flatMap((r) => levels.flatMap((g) => levels.map((b) => `#${hex(r)}${hex(g)}${hex(b)}`)));
  return [...grid, "#ffff00", "#ff00ff", "#00ffff", "#777777", "#808080", "#16181c", "#0b6b5e", "#e91e63", "#ffeb3b", "#1a1a1a"];
}

test("branding: accentFor deja cualquier color con contraste ≥ 4,5:1 en tema claro y oscuro", () => {
  for (const color of sampleColors()) {
    const light = accentFor(color, SURFACE_LIGHT, "#000000");
    const dark = accentFor(color, SURFACE_DARK, "#ffffff");
    assert.match(light, /^#[0-9a-f]{6}$/, color);
    assert.match(dark, /^#[0-9a-f]{6}$/, color);
    assert.ok(contrastRatio(light, SURFACE_LIGHT) >= AA, `${color} → ${light} en claro: ${contrastRatio(light, SURFACE_LIGHT).toFixed(2)}`);
    assert.ok(contrastRatio(dark, SURFACE_DARK) >= AA, `${color} → ${dark} en oscuro: ${contrastRatio(dark, SURFACE_DARK).toFixed(2)}`);
  }
});

test("branding: accentFor no toca un color que ya cumple y oscurece/aclara el que no", () => {
  assert.equal(accentFor("#0b6b5e", SURFACE_LIGHT, "#000000"), "#0b6b5e", "el verde del producto ya cumple en claro");
  assert.equal(accentFor("#ffeb3b", SURFACE_DARK, "#ffffff"), "#ffeb3b", "el amarillo ya cumple en oscuro");
  // Amarillo en claro: se oscurece (cada canal baja o queda), no se reemplaza por negro.
  const yellow = accentFor("#ffeb3b", SURFACE_LIGHT, "#000000");
  assert.notEqual(yellow, "#ffeb3b");
  assert.notEqual(yellow, "#000000");
  // Un color inválido vuelve tal cual (applyBranding ya lo filtra antes).
  assert.equal(accentFor("fucsia", SURFACE_LIGHT, "#000000"), "fucsia");
});

test("branding: safeLogoUrl rechaza javascript: y data: (va directo a un <img src>)", () => {
  assert.equal(safeLogoUrl("javascript:alert(1)"), null);
  assert.equal(safeLogoUrl("JavaScript:alert(1)"), null);
  assert.equal(safeLogoUrl("  javascript:alert(1)"), null);
  assert.equal(safeLogoUrl("data:image/png;base64,iVBORw0KGgo="), null);
  assert.equal(safeLogoUrl("data:image/svg+xml,<svg onload=alert(1)>"), null);
  assert.equal(safeLogoUrl("vbscript:msgbox(1)"), null);
  assert.equal(safeLogoUrl("ftp://example.com/logo.png"), null);
  assert.equal(safeLogoUrl("blob:https://example.com/abc"), null);
  assert.equal(safeLogoUrl("logo.png"), null, "relativa sin barra: ambigua, no");
  assert.equal(safeLogoUrl(""), null);
  assert.equal(safeLogoUrl(undefined), null);
});

test("branding: safeLogoUrl acepta https (y http) y rutas del mismo origen", () => {
  assert.equal(safeLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(safeLogoUrl("https://cdn.example.com/a b.png"), "https://cdn.example.com/a%20b.png", "normalizada");
  assert.equal(safeLogoUrl("http://example.com/logo.png"), "http://example.com/logo.png");
  assert.equal(safeLogoUrl("/uploads/logo.png"), "/uploads/logo.png");
  assert.equal(safeLogoUrl("/panel/icons/icon-192.png?v=2"), "/panel/icons/icon-192.png?v=2");
});

test("branding: safeLogoUrl no deja pasar una ruta que el navegador lee como otro host", () => {
  // Empiezan con "/" pero el navegador las resuelve a https://evil.example/…
  assert.equal(safeLogoUrl("//evil.example/logo.png"), null);
  assert.equal(safeLogoUrl("/\\evil.example/logo.png"), null);
  assert.equal(safeLogoUrl("/\t/evil.example/logo.png"), null);
  assert.equal(safeLogoUrl("/\n/evil.example/logo.png"), null);
});

test("branding: iniciales del chip de marca y título del documento", () => {
  assert.equal(initials("Clínica Dental Sonrisa"), "CD");
  assert.equal(initials("  estética   luna "), "EL");
  assert.equal(initials("Selyon"), "SE");
  assert.equal(initials("A"), "A");
  assert.equal(initials(""), "?");
  assert.equal(initials("   "), "?");
  assert.equal(documentTitle("Agenda"), `Agenda · ${PRODUCT_NAME}`);
  assert.equal(documentTitle(), PRODUCT_NAME);
  assert.equal(documentTitle(""), PRODUCT_NAME);
});

test("branding: el nombre del producto del panel es espejo del backend", () => {
  assert.equal(PRODUCT_NAME, SERVER_PRODUCT_NAME);
});
