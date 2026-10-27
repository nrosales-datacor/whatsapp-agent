// ─────────────────────────────────────────────────────────────────────────────
// Marca: la del producto (nombre en un solo lugar, PLAN-GESTION.md §8) y la del negocio
// (white-label). El color del negocio reemplaza SOLO el acento (--accent en global.css:
// enlaces, foco, selección); tinta, neutrales y estados no cambian, así el panel se ve
// sobrio aunque el negocio elija un fucsia. El acento se ajusta a contraste AA (≥ 4.5:1)
// contra la superficie de cada tema: se oscurece en claro y se aclara en oscuro. El color
// de encabezado solo pinta el panel de marca del acceso. Sin marca configurada no se toca
// nada. A diferencia del tema (lib/theme.ts), depende de datos del backend
// (`me.business.branding`), así que se aplica desde un efecto del layout autenticado y se
// limpia al salir.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre visible del producto (provisional). Espejo de src/platform/brand.ts. */
export const PRODUCT_NAME = "Selyon CRM";

/** Marca del negocio: colores `#rrggbb` y logo por URL (ver `Branding` del backend). */
export interface Branding {
  accentColor?: string;
  headerColor?: string;
  logoUrl?: string;
}

const RE_HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Superficies de las tarjetas en claro y oscuro (espejo de --surface en global.css). */
const SURFACE_LIGHT = "#ffffff";
const SURFACE_DARK = "#16181c";
const INK_LIGHT = "#16181d";
const INK_DARK = "#0e0f12";
/** Contraste mínimo del acento contra la superficie (WCAG AA, texto normal). */
const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb | null {
  const m = RE_HEX.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Luminancia relativa (WCAG 2.x). */
function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contraste WCAG entre dos colores (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return 1;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `hex` mezclado de a poco hacia `toward` (negro u blanco) hasta llegar al contraste mínimo
 * contra `surface`. Si ya cumple, vuelve igual.
 */
export function accentFor(hex: string, surface: string, toward: "#000000" | "#ffffff"): string {
  const base = toRgb(hex);
  const target = toRgb(toward);
  if (!base || !target) return hex;
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    const mixed = toHex([0, 1, 2].map((i) => base[i] + (target[i] - base[i]) * t) as Rgb);
    if (contrastRatio(mixed, surface) >= MIN_CONTRAST) return mixed;
  }
  return toward;
}

/** Texto sobre `hex`: blanco o tinta, el que más contraste. */
function textOn(hex: string, ink: string): string {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, ink) ? "#ffffff" : ink;
}

const BRAND_PROPERTIES = [
  "--brand-accent-light",
  "--brand-on-accent-light",
  "--brand-accent-dark",
  "--brand-on-accent-dark",
  "--brand-header-bg",
  "--brand-header-fg",
];

/** Pinta el panel con la marca del negocio. Cada color ausente o inválido deja su default. */
export function applyBranding(branding: Branding | null | undefined): void {
  resetBranding();
  const root = document.documentElement.style;
  if (branding?.accentColor && RE_HEX.test(branding.accentColor)) {
    const light = accentFor(branding.accentColor, SURFACE_LIGHT, "#000000");
    const dark = accentFor(branding.accentColor, SURFACE_DARK, "#ffffff");
    root.setProperty("--brand-accent-light", light);
    root.setProperty("--brand-on-accent-light", textOn(light, INK_LIGHT));
    root.setProperty("--brand-accent-dark", dark);
    root.setProperty("--brand-on-accent-dark", textOn(dark, INK_DARK));
  }
  if (branding?.headerColor && RE_HEX.test(branding.headerColor)) {
    root.setProperty("--brand-header-bg", branding.headerColor);
    root.setProperty("--brand-header-fg", textOn(branding.headerColor, INK_LIGHT));
  }
}

/** Vuelve a la paleta default (logout, cambio de negocio). */
export function resetBranding(): void {
  const root = document.documentElement.style;
  for (const property of BRAND_PROPERTIES) root.removeProperty(property);
}

/** Logo utilizable: solo http(s) o una ruta del mismo origen (nunca `javascript:` ni data). */
export function safeLogoUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Iniciales para el chip de marca cuando no hay logo ("Clínica Dental Sonrisa" → "CD"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

/** Título del documento: "Agenda · Selyon CRM" (o solo el producto). */
export function documentTitle(page?: string): string {
  return page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}
