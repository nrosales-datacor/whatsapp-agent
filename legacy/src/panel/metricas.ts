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

type AddonCitaMetrica = { servicioId: string; precio: number };

type CitaMetrica = {
  estado: string;
  precio?: number | null;
  servicioId: string;
  fecha: string;
  hora: string;
  clienteWa: string;
  origen?: string | null;
  addons?: AddonCitaMetrica[];
};

type CotizacionMetrica = {
  estado: string;
  montoRecuperado?: number | null;
};

type SeguimientoMetrica = {
  sentimiento: string | null;
};

/**
 * Contador de solicitudes de reseña (Carril D, 1.3): "positivo" (Excelente) recibió
 * el link; "neutral"/"negativo" no. Solo cuenta seguimientos RESPONDIDOS — uno recién
 * enviado (sentimiento null) todavía no cuenta para ninguno de los dos lados.
 */
function calcularResenas(seguimientos: SeguimientoMetrica[]) {
  const respondidos = seguimientos.filter((s) => s.sentimiento);
  const solicitadas = respondidos.filter((s) => s.sentimiento === "positivo").length;
  return {
    resenasSolicitadas: solicitadas,
    resenasNoSolicitadas: respondidos.length - solicitadas,
  };
}

/**
 * "Enviados" = a las que se les mandó al menos un toque (toque1/toque2/recuperada — nunca
 * 'agendada', que significa "el cliente agendó ANTES de que saliera ningún toque"). C1.1.
 */
function calcularRescate(cotizaciones: CotizacionMetrica[]) {
  const enviados = cotizaciones.filter((c) => c.estado === "toque1" || c.estado === "toque2" || c.estado === "recuperada");
  const recuperados = cotizaciones.filter((c) => c.estado === "recuperada");
  return {
    rescateEnviados: enviados.length,
    rescateRecuperados: recuperados.length,
    rescateTasaPct: enviados.length ? Math.round((recuperados.length / enviados.length) * 100) : undefined,
    rescateMontoRecuperado: recuperados.reduce((s, c) => s + (c.montoRecuperado ?? 0), 0),
  };
}

export function calcularMetricas(
  totalConversaciones: number,
  enModoHumano: number,
  /** Conversaciones que NUNCA pasaron a modo humano (el bot las resolvió solo). C3.3. */
  conversacionesSinEscalar: number,
  citas: CitaMetrica[],
  /** Cotizaciones del rescate de ventas (Carril D, 1.1). Vacío en repos/tests que no lo usan. */
  cotizaciones: CotizacionMetrica[] = [],
  /** Total de add-ons rechazados del tenant, para la tasa de aceptación del upsell (Carril D, 1.2). */
  rechazosAddon = 0,
  /** Seguimientos post-servicio del flujo Pro, para el contador de reseñas (Carril D, 1.3). */
  seguimientos: SeguimientoMetrica[] = [],
): Metricas {
  // No-show cuenta como "resuelta, no cancelada": queda fuera de ingresos/totalCitas
  // (no hubo servicio), pero sí de la tasa de no-show.
  const activas = citas.filter((c) => c.estado !== "cancelada" && c.estado !== "no_show");
  const totalCitas = activas.length;
  const ingresosEstimados = activas.reduce((s, c) => s + (c.precio ?? 0), 0);
  const conversionPct = totalConversaciones ? Math.round((totalCitas / totalConversaciones) * 100) : 0;

  // Upsell inteligente al agendar (Carril D, 1.2): monto de add-ons aceptados sobre citas
  // ACTIVAS (mismo criterio que ingresosEstimados: cancelada/no_show no generaron el extra).
  const montoAddons = (c: CitaMetrica) => (c.addons ?? []).reduce((s, a) => s + a.precio, 0);
  const upsellMontoExtra = activas.reduce((s, c) => s + montoAddons(c), 0);
  const citasConAddon = activas.filter((c) => (c.addons?.length ?? 0) > 0).length;
  const ticketPromedio = totalCitas ? Math.round((ingresosEstimados + upsellMontoExtra) / totalCitas) : 0;
  // Proxy: no hay un evento "ofrecido" (no todo cliente responde al upsell) — se mide
  // sobre las respuestas EXPLÍCITAS que sí quedan registradas (aceptó o rechazó).
  const upsellTasaPct =
    citasConAddon + rechazosAddon ? Math.round((citasConAddon / (citasConAddon + rechazosAddon)) * 100) : undefined;

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
    ticketPromedio,
    upsellMontoExtra,
    upsellTasaPct,
    ...calcularRescate(cotizaciones),
    ...calcularResenas(seguimientos),
  };
}
