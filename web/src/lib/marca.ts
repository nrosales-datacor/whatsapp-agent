import type { Marca } from "../api";

// ─────────────────────────────────────────────────────────────────────────────
// White-label por tenant (ROADMAP C4.1): pinta el panel con --brand-* (global.css)
// según la marca del negocio logueado. Sin marca configurada, no toca nada y queda
// la paleta verde default. A diferencia del tema (lib/tema.ts), esto depende de
// datos del backend (/me) — no puede aplicarse antes del primer render, así que se
// llama desde un efecto en Panel.tsx.
// ─────────────────────────────────────────────────────────────────────────────

const RE_HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Texto blanco o del verde oscuro default, según cuál contraste mejor con `hex`. */
function contrasteTexto(hex: string): string {
  const m = RE_HEX.exec(hex);
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  const luminancia = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminancia > 0.6 ? "#0f2723" : "#ffffff";
}

/** Pinta el panel con la marca del tenant. Cada color ausente deja su default intacto. */
export function aplicarMarca(marca: Marca | null | undefined): void {
  const raiz = document.documentElement.style;
  if (marca?.colorAcento) {
    raiz.setProperty("--brand-accent", marca.colorAcento);
    raiz.setProperty("--brand-accent-fg", contrasteTexto(marca.colorAcento));
  }
  if (marca?.colorHeader) {
    raiz.setProperty("--brand-header-bg", marca.colorHeader);
    raiz.setProperty("--brand-header-fg", contrasteTexto(marca.colorHeader));
  }
}

/** Vuelve a la paleta default (logout, o antes de aplicar la marca de otra sesión). */
export function resetMarca(): void {
  const raiz = document.documentElement.style;
  raiz.removeProperty("--brand-accent");
  raiz.removeProperty("--brand-accent-fg");
  raiz.removeProperty("--brand-header-bg");
  raiz.removeProperty("--brand-header-fg");
}
