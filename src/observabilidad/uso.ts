import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { obtenerDb as obtenerPoolGlobal } from "../db/client";
import { schema, waUsoMensual } from "../db/schema";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Contadores de uso mensual por tenant (Carril D, 0.2 — PLAN-FEATURES-FALTANTES.md).
// Objetivo: saber cuánto consume cada negocio (Meta cobra por conversación) y
// dejar listo el futuro tope de ~500 conv/mes del plan Básico — SIN bloquear
// nada todavía (decisión de producto: medir primero, activar el tope más
// adelante con datos reales). Gateado por DATABASE_URL, mismo patrón no-op que
// Sentry/Calendar/Push: sin DB no hay dónde guardar el contador y no debe romper
// el hot path del webhook ni el envío de mensajes.
// ─────────────────────────────────────────────────────────────────────────────

// Gateado por DATABASE_URL (no-op sin DB, ver comentario de arriba). El pool en sí
// es el singleton compartido de todo el proceso (ROADMAP F7): antes este módulo
// mantenía su propio pool aparte del de `tenantStore`/`server`/campañas/rescate.
function obtenerDb(): ReturnType<typeof obtenerPoolGlobal> | null {
  if (!process.env.DATABASE_URL) return null;
  return obtenerPoolGlobal();
}

/** "YYYY-MM" en UTC — alcanza para un contador mensual aproximado (no requiere la tz del tenant).
 * Exportado: F10 (observabilidad/cuotas.ts) lo necesita para leer el mes vigente con un `db`
 * inyectado (tests PGlite), igual que `obtenerUsoMensualDb` de más abajo. */
export function anioMesActual(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface Incremento {
  conversacionesIniciadas?: number;
  mensajesEntrantes?: number;
  mensajesSalientes?: number;
  plantillasMarketing?: number;
  plantillasUtilidad?: number;
  // Costo de LLM por tenant (F13 — PLAN-ESCALA-MULTITENANT.md). tokensEntrada/tokensSalida
  // son enteros normales; costoEstimadoMillonesimos está en millonésimos de dólar (ver el
  // comentario de la columna en schema.ts y src/observabilidad/costoLlm.ts).
  tokensEntrada?: number;
  tokensSalida?: number;
  costoEstimadoMillonesimos?: number;
}

/**
 * Núcleo SQL del incremento atómico (`INSERT ... ON CONFLICT DO UPDATE SET x = x + n`),
 * separado de `incrementar()` para poder probarlo contra Postgres real (PGlite) sin pasar
 * por el singleton de conexión — ver test/reliability/uso.test.ts. NO atrapa errores: eso
 * lo hace el caller (`incrementar`, fire-and-forget) para no romper el hot path del webhook.
 */
export async function incrementarUso(db: DB, tenantId: string, anioMes: string, delta: Incremento): Promise<void> {
  await db
    .insert(waUsoMensual)
    .values({
      tenantId,
      anioMes,
      conversacionesIniciadas: delta.conversacionesIniciadas ?? 0,
      mensajesEntrantes: delta.mensajesEntrantes ?? 0,
      mensajesSalientes: delta.mensajesSalientes ?? 0,
      plantillasMarketing: delta.plantillasMarketing ?? 0,
      plantillasUtilidad: delta.plantillasUtilidad ?? 0,
      tokensEntrada: delta.tokensEntrada ?? 0,
      tokensSalida: delta.tokensSalida ?? 0,
      costoEstimadoMillonesimos: delta.costoEstimadoMillonesimos ?? 0,
    })
    .onConflictDoUpdate({
      target: [waUsoMensual.tenantId, waUsoMensual.anioMes],
      set: {
        ...(delta.conversacionesIniciadas
          ? { conversacionesIniciadas: sql`${waUsoMensual.conversacionesIniciadas} + ${delta.conversacionesIniciadas}` }
          : {}),
        ...(delta.mensajesEntrantes
          ? { mensajesEntrantes: sql`${waUsoMensual.mensajesEntrantes} + ${delta.mensajesEntrantes}` }
          : {}),
        ...(delta.mensajesSalientes
          ? { mensajesSalientes: sql`${waUsoMensual.mensajesSalientes} + ${delta.mensajesSalientes}` }
          : {}),
        ...(delta.plantillasMarketing
          ? { plantillasMarketing: sql`${waUsoMensual.plantillasMarketing} + ${delta.plantillasMarketing}` }
          : {}),
        ...(delta.plantillasUtilidad
          ? { plantillasUtilidad: sql`${waUsoMensual.plantillasUtilidad} + ${delta.plantillasUtilidad}` }
          : {}),
        ...(delta.tokensEntrada ? { tokensEntrada: sql`${waUsoMensual.tokensEntrada} + ${delta.tokensEntrada}` } : {}),
        ...(delta.tokensSalida ? { tokensSalida: sql`${waUsoMensual.tokensSalida} + ${delta.tokensSalida}` } : {}),
        ...(delta.costoEstimadoMillonesimos
          ? { costoEstimadoMillonesimos: sql`${waUsoMensual.costoEstimadoMillonesimos} + ${delta.costoEstimadoMillonesimos}` }
          : {}),
      },
    });
}

async function incrementar(tenantId: string, delta: Incremento): Promise<void> {
  const d = obtenerDb();
  if (!d) return;
  try {
    await incrementarUso(d, tenantId, anioMesActual(), delta);
  } catch (e) {
    console.error("[uso] no se pudo incrementar el uso mensual:", e);
  }
}

/**
 * Registra un mensaje entrante nuevo (ya deduplicado por waMessageId). `conversacionIniciada`
 * = true si el mensaje anterior de esta conversación (si hubo) fue hace más de 24 h, o si es
 * el primer mensaje — aproxima una conversación nueva del modelo de cobro de Meta. Fire-and-
 * forget: nunca debe agregar latencia al webhook ni tirarlo si la base falla.
 */
export function registrarMensajeEntrante(tenantId: string, conversacionIniciada: boolean): void {
  void incrementar(tenantId, {
    mensajesEntrantes: 1,
    ...(conversacionIniciada ? { conversacionesIniciadas: 1 } : {}),
  });
}

/**
 * Registra un mensaje saliente ya confirmado por la Graph API (envío exitoso). `plantilla`
 * indica la categoría cuando el mensaje es una plantilla aprobada por Meta (marketing =
 * campañas C3.2; utilidad = recordatorios fuera de la ventana de 24 h). Fire-and-forget.
 */
export function registrarMensajeSaliente(tenantId: string, plantilla?: "marketing" | "utilidad"): void {
  void incrementar(tenantId, {
    mensajesSalientes: 1,
    ...(plantilla === "marketing" ? { plantillasMarketing: 1 } : {}),
    ...(plantilla === "utilidad" ? { plantillasUtilidad: 1 } : {}),
  });
}

/**
 * Registra el consumo de LLM (tokens + costo estimado) de UN turno del agente, o de UNA
 * transcripción de Whisper (F13 — PLAN-ESCALA-MULTITENANT.md). Fire-and-forget, mismo
 * criterio que `registrarMensajeEntrante`/`registrarMensajeSaliente`: el turno YA terminó
 * de responderle al cliente cuando esto corre, así que nunca debe agregar latencia ni
 * tumbar nada si la base falla. Para Whisper, `tokensEntrada`/`tokensSalida` van en 0 (no
 * se mide en tokens, ver costoLlm.ts) y solo se suma el costo.
 */
export function registrarUsoLlm(
  tenantId: string,
  tokensEntrada: number,
  tokensSalida: number,
  costoEstimadoMillonesimos: number,
): void {
  if (tokensEntrada <= 0 && tokensSalida <= 0 && costoEstimadoMillonesimos <= 0) return; // nada que sumar
  void incrementar(tenantId, { tokensEntrada, tokensSalida, costoEstimadoMillonesimos });
}

export interface UsoMensualTenant {
  conversacionesIniciadas: number;
  mensajesEntrantes: number;
  mensajesSalientes: number;
  plantillasMarketing: number;
  plantillasUtilidad: number;
  tokensEntrada: number;
  tokensSalida: number;
  /** Millonésimos de dólar (1 unidad = USD 0,000001). Dividir entre 1_000_000 para USD. */
  costoEstimadoMillonesimos: number;
}

/**
 * Núcleo de lectura, testable con `db` inyectado (PGlite) — mismo split que
 * `incrementarUso`/`incrementar` de más arriba: esto es lo que se prueba contra
 * Postgres real; `obtenerUsoMensual` es el wrapper de producción sobre el pool
 * singleton. F10 (observabilidad/cuotas.ts) lo usa para el enforcement del tope
 * mensual con un `db` de test sin pasar por el singleton (que no puede apuntar
 * a PGlite).
 */
export async function obtenerUsoMensualDb(db: DB, tenantId: string, anioMes: string): Promise<UsoMensualTenant | null> {
  const filas = await db
    .select()
    .from(waUsoMensual)
    .where(and(eq(waUsoMensual.tenantId, tenantId), eq(waUsoMensual.anioMes, anioMes)))
    .limit(1);
  const f = filas[0];
  if (!f) return null;
  return {
    conversacionesIniciadas: f.conversacionesIniciadas,
    mensajesEntrantes: f.mensajesEntrantes,
    mensajesSalientes: f.mensajesSalientes,
    plantillasMarketing: f.plantillasMarketing,
    plantillasUtilidad: f.plantillasUtilidad,
    tokensEntrada: f.tokensEntrada,
    tokensSalida: f.tokensSalida,
    costoEstimadoMillonesimos: f.costoEstimadoMillonesimos,
  };
}

/** Uso del mes actual de UN tenant. null sin DB, o si todavía no tiene actividad este mes. */
export async function obtenerUsoMensual(tenantId: string): Promise<UsoMensualTenant | null> {
  const d = obtenerDb();
  if (!d) return null;
  return obtenerUsoMensualDb(d, tenantId, anioMesActual());
}

/**
 * Uso del mes actual de TODOS los tenants con actividad, indexado por tenantId — para la
 * columna "Conversaciones este mes" del admin (una sola consulta en vez de N). Mapa vacío
 * sin DB o sin actividad todavía este mes.
 */
export async function listarUsoMensualActual(): Promise<Map<string, UsoMensualTenant>> {
  const mapa = new Map<string, UsoMensualTenant>();
  const d = obtenerDb();
  if (!d) return mapa;
  const filas = await d.select().from(waUsoMensual).where(eq(waUsoMensual.anioMes, anioMesActual()));
  for (const f of filas) {
    mapa.set(f.tenantId, {
      conversacionesIniciadas: f.conversacionesIniciadas,
      mensajesEntrantes: f.mensajesEntrantes,
      mensajesSalientes: f.mensajesSalientes,
      plantillasMarketing: f.plantillasMarketing,
      plantillasUtilidad: f.plantillasUtilidad,
      tokensEntrada: f.tokensEntrada,
      tokensSalida: f.tokensSalida,
      costoEstimadoMillonesimos: f.costoEstimadoMillonesimos,
    });
  }
  return mapa;
}
