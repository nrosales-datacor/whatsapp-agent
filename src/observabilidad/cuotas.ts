import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Tenant } from "../types";
import { TOPE_CONVERSACIONES_MES } from "../billing/planes";
import { anioMesActual, obtenerUsoMensual, obtenerUsoMensualDb } from "./uso";

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
