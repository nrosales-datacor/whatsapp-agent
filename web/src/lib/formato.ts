// Helpers de formato del panel (es-CR). React escapa el texto solo, así que acá
// NO hace falta el `esc()` que tenía el inbox.html (concatenaba HTML a mano).

/** Hora local "HH:mm" a partir de un ISO; "" si no hay fecha. */
export function hora(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" }) : "";
}

/** Fecha local corta a partir de un ISO; "—" si no hay fecha. */
export function fechaCorta(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("es-CR") : "—";
}

/** Número de WhatsApp (E.164 sin "+") a formato visible. */
export function fmtNum(wa: string): string {
  return "+" + wa;
}

/** Monto en colones para el dashboard. */
export function colones(n: number): string {
  return "₡" + (n || 0).toLocaleString("es-CR");
}

/** Iniciales del nombre del negocio para el chip de marca sin logo (máx. 2 letras). */
export function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return "";
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}
