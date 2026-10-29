// ─────────────────────────────────────────────────────────────────────────────
// Marca: la del producto (nombre en un solo lugar, PLAN-GESTION.md §8) y la del negocio
// (white-label). La del negocio pinta el panel con las variables --brand-* de global.css;
// sin marca configurada no se toca nada y queda la paleta default. A diferencia del tema
// (lib/theme.ts), depende de datos del backend (`me.business.branding`), así que se aplica
// desde un efecto del layout autenticado y se limpia al salir.
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

/** Texto blanco o casi negro, según cuál contraste mejor con `hex`. */
function contrastText(hex: string): string {
  const m = RE_HEX.exec(hex);
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? "#0f2723" : "#ffffff";
}

/** Pinta el panel con la marca del negocio. Cada color ausente o inválido deja su default. */
export function applyBranding(branding: Branding | null | undefined): void {
  resetBranding();
  const root = document.documentElement.style;
  if (branding?.accentColor && RE_HEX.test(branding.accentColor)) {
    root.setProperty("--brand-accent", branding.accentColor);
    root.setProperty("--brand-accent-fg", contrastText(branding.accentColor));
  }
  if (branding?.headerColor && RE_HEX.test(branding.headerColor)) {
    root.setProperty("--brand-header-bg", branding.headerColor);
    root.setProperty("--brand-header-fg", contrastText(branding.headerColor));
  }
}

/** Vuelve a la paleta default (logout, cambio de negocio). */
export function resetBranding(): void {
  const root = document.documentElement.style;
  root.removeProperty("--brand-accent");
  root.removeProperty("--brand-accent-fg");
  root.removeProperty("--brand-header-bg");
  root.removeProperty("--brand-header-fg");
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
