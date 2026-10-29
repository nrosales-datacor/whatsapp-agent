import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// Tema claro/oscuro del panel. Se aplica con `data-theme` en <html> (ver los tokens de
// global.css). Sin preferencia guardada se sigue la del sistema operativo.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "selyon.theme";
export type Theme = "light" | "dark";

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getTheme(): Theme {
  const saved = readStorage(STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : systemTheme();
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Llamar ANTES del primer render (main.tsx) para que no parpadee el tema equivocado. */
export function initTheme(): void {
  applyTheme(getTheme());
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  writeStorage(STORAGE_KEY, next);
  applyTheme(next);
  return next;
}

/** Para los componentes que muestran el tema actual (p. ej. el ítem del menú de usuario). */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const toggle = useCallback(() => setTheme(toggleTheme()), []);
  return { theme, toggle };
}
