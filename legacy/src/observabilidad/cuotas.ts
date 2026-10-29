import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Tenant } from "../types";
import { TOPE_CONVERSACIONES_MES, topeGastoLlmUsd } from "../billing/planes";
import { anioMesActual, obtenerUsoMensual, obtenerUsoMensualDb, type UsoMensualTenant } from "./uso";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement del tope mensual de conversaciones (F10 — PLAN-ESCALA-MULTITENANT.md).
// `wa_uso_mensual` (uso.ts) mide desde Carril D 0.2, pero nunca bloqueaba nada — el
// tope de ~500 conv/mes del plan Básico se le vendía al cliente sin existir en
// código. Este módulo es el ÚNICO lugar que decide "¿este tenant puede seguir
// hablando con el bot este mes?", para no duplicar el criterio (80%/100%,
// interruptor) entre handleWebhook.ts (enforcement) y router.ts (exposición al
// panel) — ambos llaman a `calcularEstadoCuota`/`estadoCuotaMensual`.
//
// `db` opcional en `estadoCuotaMensual`, mismo patrón que `ingerirEntrante(body,
// repo, db?)` de F3: en producción el pool singleton (uso.ts → obtenerDb()) ya
// resuelve solo con DATABASE_URL, así que nadie necesita pasar `db`; los tests de
// fiabilidad (PGlite) SÍ lo pasan, porque el singleton de postgres.js no puede
// apuntar a una base efímera en memoria.
// ─────────────────────────────────────────────────────────────────────────────

export interface EstadoCuotaMensual {
  /** Tope de conversaciones/mes vigente para este tenant. null = sin tope (plan Pro, o interruptor activado). */
  tope: number | null;
  /** Conversaciones iniciadas en el mes actual (aprox. modelo de cobro de Meta, ver esConversacionIniciada). */
  usados: number;
  /** 0-100+ (puede pasar de 100 si se lee después de excederse). null si no hay tope. */
  porcentaje: number | null;
  /** true desde el 80% del tope (aviso al dueño en el panel). Siempre false sin tope. */
  alcanzo80: boolean;
  /** true al 100% o más del tope (el bot deja de llamar al LLM para este tenant). Siempre false sin tope. */
  excedido: boolean;
}

const UMBRAL_AVISO_PORCENTAJE = 80;

/** Cálculo puro (sin I/O): separado para poder probarlo sin tocar la base y para
 * que `estadoCuotaMensual`/el listado de `admin/tenants` (que ya trae el uso de
 * TODOS los tenants en una sola consulta) no dupliquen la aritmética. */
export function calcularEstadoCuota(tenant: Tenant, conversacionesIniciadas: number): EstadoCuotaMensual {
  const tope = tenant.topeConversacionesDesactivado ? null : TOPE_CONVERSACIONES_MES[tenant.plan];
  if (tope === null) {
    return { tope: null, usados: conversacionesIniciadas, porcentaje: null, alcanzo80: false, excedido: false };
  }
  const porcentaje = tope > 0 ? Math.round((conversacionesIniciadas / tope) * 100) : 100;
  return {
    tope,
    usados: conversacionesIniciadas,
    porcentaje,
    alcanzo80: porcentaje >= UMBRAL_AVISO_PORCENTAJE,
    excedido: conversacionesIniciadas >= tope,
  };
}

/**
 * Estado de cuota de UN tenant, leyendo su uso del mes actual. `db` opcional
 * (ver comentario de cabecera) — sin él, usa el pool singleton de producción.
 */
export async function estadoCuotaMensual(tenant: Tenant, db?: DB): Promise<EstadoCuotaMensual> {
  const uso = db ? await obtenerUsoMensualDb(db, tenant.id, anioMesActual()) : await obtenerUsoMensual(tenant.id);
  return calcularEstadoCuota(tenant, uso?.conversacionesIniciadas ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tope mensual de GASTO de LLM en USD (revisión pre-venta 2026-10; tope por plan +
// override por tenant en billing/planes.ts). Mismo criterio 80%/100% que el de
// conversaciones y mismo split puro/I-O, para que handleWebhook.ts (enforcement) y
// router.ts (GET /me, admin/tenants) no dupliquen la aritmética.
//
// El costo se registra fire-and-forget al TERMINAR cada turno (uso.ts →
// registrarUsoLlm), así que el corte llega con un turno de atraso como mucho: el
// turno que cruza el 100% se completa, el siguiente ya no llama al LLM. Para un
// tope de USD 15-40 ese desfase (≈ USD 0,002) es irrelevante.
// ─────────────────────────────────────────────────────────────────────────────

export interface EstadoGastoLlm {
  /** Tope de gasto del mes en USD. null = sin tope (override del tenant en 0). */
  topeUsd: number | null;
  /** Gasto estimado acumulado del mes en USD (solo presentación: la fuente es el entero en millonésimos). */
  gastoUsd: number;
  /** 0-100+ (puede pasar de 100). null si no hay tope. */
  porcentaje: number | null;
  /** true desde el 80% del tope. Siempre false sin tope. */
  alcanzo80: boolean;
  /** true al 100% o más: el bot deja de llamar al LLM para este tenant. Siempre false sin tope. */
  excedido: boolean;
}

/** Cálculo puro (sin I/O) del estado de gasto, a partir del acumulado en millonésimos de dólar. */
export function calcularEstadoGastoLlm(tenant: Tenant, costoMillonesimos: number): EstadoGastoLlm {
  const gastoUsd = costoMillonesimos / 1_000_000;
  const topeUsd = topeGastoLlmUsd(tenant);
  if (topeUsd === null) {
    return { topeUsd: null, gastoUsd, porcentaje: null, alcanzo80: false, excedido: false };
  }
  // Comparación en millonésimos (enteros) para el corte, no en float.
  const topeMillonesimos = Math.round(topeUsd * 1_000_000);
  const porcentaje = Math.round((costoMillonesimos / topeMillonesimos) * 100);
  return {
    topeUsd,
    gastoUsd,
    porcentaje,
    alcanzo80: porcentaje >= UMBRAL_AVISO_PORCENTAJE,
    excedido: costoMillonesimos >= topeMillonesimos,
  };
}

export interface EstadoCuotasDelMes {
  conversaciones: EstadoCuotaMensual;
  gastoLlm: EstadoGastoLlm;
}

/** Ambos topes desde UNA fila de uso ya leída (o null si no hay actividad este mes). */
export function calcularEstadoCuotasDelMes(tenant: Tenant, uso: UsoMensualTenant | null | undefined): EstadoCuotasDelMes {
  return {
    conversaciones: calcularEstadoCuota(tenant, uso?.conversacionesIniciadas ?? 0),
    gastoLlm: calcularEstadoGastoLlm(tenant, uso?.costoEstimadoMillonesimos ?? 0),
  };
}

/**
 * Estado de los DOS topes mensuales (conversaciones + gasto de LLM) con una sola
 * lectura de `wa_uso_mensual`. Es lo que usa el enforcement antes de cada llamada
 * al LLM y GET /me. `db` opcional, mismo criterio que `estadoCuotaMensual`.
 */
export async function estadoCuotasDelMes(tenant: Tenant, db?: DB): Promise<EstadoCuotasDelMes> {
  const uso = db ? await obtenerUsoMensualDb(db, tenant.id, anioMesActual()) : await obtenerUsoMensual(tenant.id);
  return calcularEstadoCuotasDelMes(tenant, uso);
}
