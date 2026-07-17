// Helpers de formato del panel (es-CR). React escapa el texto solo, así que acá
// NO hace falta el `esc()` que tenía el inbox.html (concatenaba HTML a mano).

/** Hora local "HH:mm" a partir de un ISO; "" si no hay fecha. */
export function hora(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" }) : "";
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/**
 * Fecha en formato dd/mm/yyyy fijo (no depende del locale del navegador); "—" si no
 * hay fecha o es inválida. Un string "YYYY-MM-DD" puro (sin hora, ej. `Cita.fecha`)
 * se interpreta en UTC para no correr un día por el offset de zona horaria del
 * cliente; un ISO con hora se interpreta en la zona local, como corresponde a un
 * instante real.
 */
export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dia = soloFecha ? d.getUTCDate() : d.getDate();
  const mes = (soloFecha ? d.getUTCMonth() : d.getMonth()) + 1;
  const anio = soloFecha ? d.getUTCFullYear() : d.getFullYear();
  return `${pad2(dia)}/${pad2(mes)}/${anio}`;
}

/** Fecha dd/mm/yyyy + hora "HH:mm" a partir de un ISO; "—" si no hay fecha. */
export function fechaHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${fechaCorta(iso)} ${hora(iso)}`;
}

/** Número de WhatsApp (E.164 sin "+") a formato visible. */
export function fmtNum(wa: string): string {
  return "+" + wa;
}

/** Monto en colones para el dashboard. */
export function colones(n: number): string {
  return "₡" + (n || 0).toLocaleString("es-CR");
}

/** Tiempo restante hasta un ISO futuro, "Xh Ym" o "Ym" (ventana de 24h, Carril D 0.3). "" si no hay fecha. */
export function restante(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "0m";
  const horas = Math.floor(ms / (60 * 60 * 1000));
  const minutos = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;
}

/** Tiempo transcurrido desde un ISO pasado, "Xh Ym" o "Ym" (bandeja: "Sin responder hace…"). "" si no hay fecha. */
export function transcurrido(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return "0m";
  const horas = Math.floor(ms / (60 * 60 * 1000));
  const minutos = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;
}

/** Iniciales del nombre del negocio para el chip de marca sin logo (máx. 2 letras). */
export function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return "";
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}
