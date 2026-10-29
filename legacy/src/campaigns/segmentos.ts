import { eq } from "drizzle-orm";
import { waCitas, waConversaciones } from "../db/schema";
import type { ClienteSegmento, SegmentoFiltro } from "../types";
import { obtenerDb } from "./db";
import { conTenant, type Tx } from "../db/alcance";

// ─────────────────────────────────────────────────────────────────────────────
// Segmentación del CRM para campañas (ROADMAP C3.2). Agrega en MEMORIA (mismo
// estilo que calcularMetricas, src/panel/metricas.ts): trae todas las citas y
// conversaciones del tenant y agrupa por clienteWa — la escala de un negocio
// piloto no justifica SQL de agregación.
// ─────────────────────────────────────────────────────────────────────────────

const DIAS_POR_MES = 30;
const DEFAULT_DIAS_INACTIVOS = 60;
const DEFAULT_MESES_SERVICIO = 6;

/** "YYYY-MM-DD" de hace `dias` días respecto de `hoy` (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaHaceDias(dias: number, hoy: string): string {
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

type CitaSegmento = { clienteWa: string; clienteNombre: string; fecha: string; estado: string; servicioId: string };
type ConversacionSegmento = { clienteWa: string; optOutEn: unknown; marketingConsentimientoEn: unknown };

/** Resultado del segmento con el desglose de a quién se excluyó (lo muestra el panel). */
export interface DetalleSegmento {
  /** Los que reciben la campaña: califican, dieron consentimiento y no pidieron la baja. */
  destinatarios: ClienteSegmento[];
  /** Califican por el filtro pero NUNCA dieron consentimiento de marketing (no se les envía). */
  sinConsentimiento: number;
  /** Califican por el filtro pero pidieron la baja (no se les envía). */
  conBaja: number;
}

/**
 * Agrega citas + conversaciones y arma la lista de destinatarios que califican
 * para el segmento de una campaña. Pura (sin I/O): mismo estilo que
 * calcularMetricas (src/panel/metricas.ts). Filtro OBLIGATORIO para todos los
 * segmentos: solo quedan los clientes con consentimiento EXPLÍCITO de marketing
 * (`marketingConsentimientoEn`, botón "Sí" — ver consentimiento.ts) y que no
 * pidieron la baja (`optOutEn`). `hoy` ("YYYY-MM-DD") es inyectable para pruebas
 * deterministas; por defecto la fecha actual.
 */
export function calcularSegmentoDetalle(
  citas: CitaSegmento[],
  conversaciones: ConversacionSegmento[],
  filtro: SegmentoFiltro,
  hoy: string = new Date().toISOString().slice(0, 10),
): DetalleSegmento {
  const optOut = new Set(conversaciones.filter((c) => c.optOutEn).map((c) => c.clienteWa));
  const conConsentimiento = new Set(
    conversaciones.filter((c) => c.marketingConsentimientoEn).map((c) => c.clienteWa),
  );

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
    // Todos los clientes que alguna vez escribieron, tengan cita o no (el filtro de
    // consentimiento de abajo deja solo a los que dijeron que sí).
    resultado = conversaciones.map((conv) => {
      const a = porCliente.get(conv.clienteWa);
      return { clienteWa: conv.clienteWa, nombre: a?.nombre ?? "estimado cliente", ultimaVisita: a?.ultimaVisita ?? null };
    });
  } else if (filtro.tipo === "inactivos") {
    const corte = fechaHaceDias(filtro.dias ?? DEFAULT_DIAS_INACTIVOS, hoy);
    resultado = [...porCliente.values()]
      .filter((a) => a.ultimaVisita !== null && a.ultimaVisita <= corte)
      .map((a) => ({ clienteWa: a.clienteWa, nombre: a.nombre, ultimaVisita: a.ultimaVisita }));
  } else {
    // "servicio_antiguo"
    if (!filtro.servicioId) return { destinatarios: [], sinConsentimiento: 0, conBaja: 0 };
    const corte = fechaHaceDias((filtro.meses ?? DEFAULT_MESES_SERVICIO) * DIAS_POR_MES, hoy);
    resultado = [...porCliente.values()]
      .filter((a) => {
        const f = a.ultimaCompletadaPorServicio.get(filtro.servicioId!);
        return f !== undefined && f <= corte;
      })
      .map((a) => ({ clienteWa: a.clienteWa, nombre: a.nombre, ultimaVisita: a.ultimaVisita }));
  }

  let conBaja = 0;
  let sinConsentimiento = 0;
  const destinatarios = resultado.filter((r) => {
    if (optOut.has(r.clienteWa)) {
      conBaja++;
      return false;
    }
    if (!conConsentimiento.has(r.clienteWa)) {
      sinConsentimiento++;
      return false;
    }
    return true;
  });
  destinatarios.sort((a, b) => (b.ultimaVisita ?? "").localeCompare(a.ultimaVisita ?? ""));
  return { destinatarios, sinConsentimiento, conBaja };
}

/** Igual que calcularSegmentoDetalle pero solo la lista de destinatarios. */
export function calcularSegmento(
  citas: CitaSegmento[],
  conversaciones: ConversacionSegmento[],
  filtro: SegmentoFiltro,
  hoy: string = new Date().toISOString().slice(0, 10),
): ClienteSegmento[] {
  return calcularSegmentoDetalle(citas, conversaciones, filtro, hoy).destinatarios;
}

/** Segmento del tenant con el desglose de excluidos (sin consentimiento / con baja). */
export async function previsualizarSegmentoDetalle(tenantId: string, filtro: SegmentoFiltro): Promise<DetalleSegmento> {
  return conTenant(obtenerDb(), tenantId, (tx) => segmentoEnTransaccion(tx, tenantId, filtro));
}

/** Igual que `previsualizarSegmentoDetalle`, dentro de una transacción ya acotada al negocio. */
export async function segmentoEnTransaccion(tx: Tx, tenantId: string, filtro: SegmentoFiltro): Promise<DetalleSegmento> {
  const [citas, conversaciones] = await Promise.all([
    tx.select().from(waCitas).where(eq(waCitas.tenantId, tenantId)),
    tx.select().from(waConversaciones).where(eq(waConversaciones.tenantId, tenantId)),
  ]);
  return calcularSegmentoDetalle(citas, conversaciones, filtro);
}

/**
 * Arma la lista de destinatarios que califican para el segmento de una campaña.
 * Solo clientes con consentimiento de marketing y sin baja (ver calcularSegmentoDetalle).
 */
export async function previsualizarSegmento(tenantId: string, filtro: SegmentoFiltro): Promise<ClienteSegmento[]> {
  return (await previsualizarSegmentoDetalle(tenantId, filtro)).destinatarios;
}

/** Resumen del tenant para el panel de campañas: cuántos clientes dieron permiso de promociones. */
export async function resumenConsentimiento(
  tenantId: string,
): Promise<{ clientes: number; conConsentimiento: number; conBaja: number }> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const filas = await d
      .select({ optOutEn: waConversaciones.optOutEn, consentimientoEn: waConversaciones.marketingConsentimientoEn })
      .from(waConversaciones)
      .where(eq(waConversaciones.tenantId, tenantId));
    return {
      clientes: filas.length,
      conConsentimiento: filas.filter((f) => f.consentimientoEn && !f.optOutEn).length,
      conBaja: filas.filter((f) => f.optOutEn).length,
    };
  });
}
