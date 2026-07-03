import { useState, useCallback } from "react";

const KEY = "panel-tema";
export type Tema = "claro" | "oscuro";

export function getTema(): Tema {
  return (localStorage.getItem(KEY) as Tema) ?? "claro";
}

function aplicar(tema: Tema) {
  document.documentElement.dataset.tema = tema;
}

/** Llamar ANTES del primer render (en main.tsx) para evitar flash de tema incorrecto. */
export function initTema() {
  aplicar(getTema());
}

export function alternarTema(): Tema {
  const siguiente: Tema = getTema() === "claro" ? "oscuro" : "claro";
  localStorage.setItem(KEY, siguiente);
  aplicar(siguiente);
  return siguiente;
}

/** Hook para componentes que necesitan reaccionar al cambio de tema (p. ej. el ícono del toggle). */
export function useTema() {
  const [tema, setTema] = useState<Tema>(getTema);
  const alternar = useCallback(() => {
    const nuevo = alternarTema();
    setTema(nuevo);
  }, []);
  return { tema, alternar };
}
