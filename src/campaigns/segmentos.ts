import { eq } from "drizzle-orm";
import { waCitas, waConversaciones } from "../db/schema";
import type { ClienteSegmento, SegmentoFiltro } from "../types";
import { obtenerDb } from "./db";

// ─────────────────────────────────────────────────────────────────────────────
// Segmentación del CRM para campañas (ROADMAP C3.2). Agrega en MEMORIA (mismo
// estilo que calcularMetricas, src/panel/metricas.ts): trae todas las citas y
// conversaciones del tenant y agrupa por clienteWa — la escala de un negocio
// piloto no justifica SQL de agregación.
// ─────────────────────────────────────────────────────────────────────────────

const DIAS_POR_MES = 30;
const DEFAULT_DIAS_INACTIVOS = 60;
const DEFAULT_MESES_SERVICIO = 6;

/** "YYYY-MM-DD" de hace `dias` días (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaHaceDias(dias: number): string {
  const hoy = new Date().toISOString().slice(0, 10);
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

interface AgregadoCliente {
  clienteWa: string;
  nombre: string;
  nombreFecha: string; // fecha de la cita que fijó `nombre` (para quedarnos con la más reciente)
  ultimaVisita: string | null; // última cita NO cancelada
  ultimaCompletadaPorServicio: Map<string, string>; // servicioId -> última fecha completada
}

/**
 * Arma la lista de destinatarios que califican para el segmento de una campaña.
 * Excluye SIEMPRE a los clientes que pidieron baja ("BAJA", opt-out de marketing).
 */
export async function previsualizarSegmento(tenantId: string, filtro: SegmentoFiltro): Promise<ClienteSegmento[]> {
  const d = obtenerDb();
  const [citas, conversaciones] = await Promise.all([
    d.select().from(waCitas).where(eq(waCitas.tenantId, tenantId)),
    d.select().from(waConversaciones).where(eq(waConversaciones.tenantId, tenantId)),
  ]);

  const optOut = new Set(conversaciones.filter((c) => c.optOutEn).map((c) => c.clienteWa));

  const porCliente = new Map<string, AgregadoCliente>();
  for (const c of citas) {
    let a = porCliente.get(c.clienteWa);
    if (!a) {
      a = {
        clienteWa: c.clienteWa,
        nombre: c.clienteNombre,
        nombreFecha: c.fecha,
        ultimaVisita: null,
        ultimaCompletadaPorServicio: new Map(),
      };
      porCliente.set(c.clienteWa, a);
    }
    if (c.fecha > a.nombreFecha) {
      a.nombre = c.clienteNombre;
      a.nombreFecha = c.fecha;
    }
    if (c.estado !== "cancelada" && (a.ultimaVisita === null || c.fecha > a.ultimaVisita)) {
      a.ultimaVisita = c.fecha;
    }
    if (c.estado === "completada") {
      const actual = a.ultimaCompletadaPorServicio.get(c.servicioId);
      if (!actual || c.fecha > actual) a.ultimaCompletadaPorServicio.set(c.servicioId, c.fecha);
    }
  }

  let resultado: ClienteSegmento[];
  if (filtro.tipo === "todos") {
    // Todos los clientes que alguna vez escribieron, tengan cita o no.
    resultado = conversaciones.map((conv) => {
      const a = porCliente.get(conv.clienteWa);
      return { clienteWa: conv.clienteWa, nombre: a?.nombre ?? "estimado cliente", ultimaVisita: a?.ultimaVisita ?? null };
    });
  } else if (filtro.tipo === "inactivos") {
    const corte = fechaHaceDias(filtro.dias ?? DEFAULT_DIAS_INACTIVOS);
    resultado = [...porCliente.values()]
      .filter((a) => a.ultimaVisita !== null && a.ultimaVisita <= corte)
      .map((a) => ({ clienteWa: a.clienteWa, nombre: a.nombre, ultimaVisita: a.ultimaVisita }));
  } else {
    // "servicio_antiguo"
    if (!filtro.servicioId) return [];
    const corte = fechaHaceDias((filtro.meses ?? DEFAULT_MESES_SERVICIO) * DIAS_POR_MES);
    resultado = [...porCliente.values()]
      .filter((a) => {
        const f = a.ultimaCompletadaPorServicio.get(filtro.servicioId!);
        return f !== undefined && f <= corte;
      })
      .map((a) => ({ clienteWa: a.clienteWa, nombre: a.nombre, ultimaVisita: a.ultimaVisita }));
  }

  return resultado
    .filter((r) => !optOut.has(r.clienteWa))
    .sort((a, b) => (b.ultimaVisita ?? "").localeCompare(a.ultimaVisita ?? ""));
}
