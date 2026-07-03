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

type CitaMetrica = { estado: string; precio?: number | null; servicioId: string; fecha: string; hora: string };

export function calcularMetricas(
  totalConversaciones: number,
  enModoHumano: number,
  citas: CitaMetrica[],
): Metricas {
  const activas = citas.filter((c) => c.estado !== "cancelada");
  const totalCitas = activas.length;
  const ingresosEstimados = activas.reduce((s, c) => s + (c.precio ?? 0), 0);
  const conversionPct = totalConversaciones ? Math.round((totalCitas / totalConversaciones) * 100) : 0;

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

  return { totalConversaciones, totalCitas, conversionPct, ingresosEstimados, enModoHumano, serviciosTop, citasPorDia, horasPico };
}
