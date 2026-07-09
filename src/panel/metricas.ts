import type { Metricas } from "../types";

// Cálculo puro de métricas a partir de las citas y conversaciones de un negocio.
// Se usa desde ambos repositorios (memoria y Drizzle).

/**
 * Formatea la variación porcentual entre dos períodos de 7 días.
 * Devuelve undefined si no hay período anterior (no hay datos comparables).
 */
export function formatDelta(actual: number, previo: number): string | undefined {
  if (previo === 0) return actual > 0 ? "+∞" : undefined;
  const pct = Math.round(((actual - previo) / previo) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

type CitaMetrica = {
  estado: string;
  precio?: number | null;
  servicioId: string;
  fecha: string;
  hora: string;
  clienteWa: string;
  origen?: string | null;
};

export function calcularMetricas(
  totalConversaciones: number,
  enModoHumano: number,
  /** Conversaciones que NUNCA pasaron a modo humano (el bot las resolvió solo). C3.3. */
  conversacionesSinEscalar: number,
  citas: CitaMetrica[],
): Metricas {
  // No-show cuenta como "resuelta, no cancelada": queda fuera de ingresos/totalCitas
  // (no hubo servicio), pero sí de la tasa de no-show.
  const activas = citas.filter((c) => c.estado !== "cancelada" && c.estado !== "no_show");
  const totalCitas = activas.length;
  const ingresosEstimados = activas.reduce((s, c) => s + (c.precio ?? 0), 0);
  const conversionPct = totalConversaciones ? Math.round((totalCitas / totalConversaciones) * 100) : 0;

  const completadas = citas.filter((c) => c.estado === "completada").length;
  const noShows = citas.filter((c) => c.estado === "no_show").length;
  const resueltas = completadas + noShows;
  const noShowPct = resueltas ? Math.round((noShows / resueltas) * 100) : undefined;

  const citasBot = activas.filter((c) => (c.origen ?? "bot") === "bot").length;
  const citasManuales = activas.filter((c) => (c.origen ?? "bot") === "manual").length;

  // Fidelización: por cliente, a lo largo de TODA su historia (no solo activas) —
  // una cita cancelada/no-show igual cuenta como contacto previo con el negocio.
  const citasPorCliente = new Map<string, number>();
  for (const c of citas) citasPorCliente.set(c.clienteWa, (citasPorCliente.get(c.clienteWa) ?? 0) + 1);
  let clientesNuevos = 0;
  let clientesRecurrentes = 0;
  for (const n of citasPorCliente.values()) (n > 1 ? clientesRecurrentes++ : clientesNuevos++);

  const ahorroBotPct = totalConversaciones ? Math.round((conversacionesSinEscalar / totalConversaciones) * 100) : 0;

  const cuenta = (clave: (c: CitaMetrica) => string) => {
    const m = new Map<string, number>();
    for (const c of activas) m.set(clave(c), (m.get(clave(c)) ?? 0) + 1);
    return m;
  };

  const serviciosTop = [...cuenta((c) => c.servicioId).entries()]
    .map(([servicioId, cantidad]) => ({ servicioId, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 6);

  const citasPorDia = [...cuenta((c) => c.fecha).entries()]
    .map(([fecha, cantidad]) => ({ fecha, cantidad }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(-14);

  const horasPico = [...cuenta((c) => c.hora).entries()]
    .map(([hora, cantidad]) => ({ hora, cantidad }))
    .sort((a, b) => a.hora.localeCompare(b.hora));

  return {
    totalConversaciones,
    totalCitas,
    conversionPct,
    ingresosEstimados,
    enModoHumano,
    serviciosTop,
    citasPorDia,
    horasPico,
    noShowPct,
    citasBot,
    citasManuales,
    clientesNuevos,
    clientesRecurrentes,
    ahorroBotPct,
  };
}
