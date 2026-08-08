import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { waWebhooksCrudos, schema } from "./schema";
import { filasDe } from "./filas";
import { capturarError } from "../observabilidad/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a `wa_webhooks_crudos` (ROADMAP F3): red de seguridad para los dos
// caminos del webhook que ANTES descartaban el mensaje sin dejar rastro (tenant
// desconocido / payload no parseable). Ver el comentario de la tabla en
// db/schema.ts para el motivo de cada columna.
//
// Este módulo es SOLO acceso a datos: no conoce `Repositorio` ni `handleWebhook`.
// El reproceso (que sí necesita reinyectar por `ingerirEntrante`) vive aparte, en
// `src/whatsapp/reprocesoWebhooks.ts`, para no crear un ciclo de imports.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

export type MotivoDescarte = "tenant_desconocido" | "no_parseable";

/**
 * Guarda el payload crudo de un mensaje que el webhook NO pudo procesar. Nunca
 * lanza: es una red de seguridad, y una falla acá no puede ser un modo de falla
 * NUEVO para el webhook (si esto revienta, igual respondemos 200 — perder la
 * fila de diagnóstico es preferible a caerse el webhook entero).
 *
 * `onConflictDoNothing` (sin target explícito, mismo idioma que
 * `waSeguimientos.crearSeguimiento`) absorbe el reintento de Meta con el mismo
 * `wa_message_id`: no duplica la fila.
 */
export async function guardarCrudo(
  db: DB,
  input: { payload: unknown; phoneNumberId: string | null; waMessageId: string | null; motivo: MotivoDescarte },
): Promise<void> {
  try {
    await db
      .insert(waWebhooksCrudos)
      .values({
        payload: input.payload,
        phoneNumberId: input.phoneNumberId,
        waMessageId: input.waMessageId,
        motivo: input.motivo,
      })
      .onConflictDoNothing();
    registrarParaAlerta(input.motivo);
  } catch (e) {
    console.error("[webhooksCrudos] no se pudo guardar el crudo (red de seguridad de F3):", e);
    capturarError(e, { modulo: "webhooksCrudos", accion: "guardarCrudo", motivo: input.motivo });
  }
}

/** Fila mínima que necesita el reproceso: id + lo que hace falta para reintentar. */
export interface CrudoPendiente {
  id: string;
  payload: unknown;
  phoneNumberId: string | null;
  intentos: number;
}

/** Pendientes más viejos primero (el índice `wa_webhooks_crudos_pendiente_idx` cubre esto). */
export async function listarPendientes(db: DB, limite = 200): Promise<CrudoPendiente[]> {
  return db
    .select({
      id: waWebhooksCrudos.id,
      payload: waWebhooksCrudos.payload,
      phoneNumberId: waWebhooksCrudos.phoneNumberId,
      intentos: waWebhooksCrudos.intentos,
    })
    .from(waWebhooksCrudos)
    .where(eq(waWebhooksCrudos.estado, "pendiente"))
    .orderBy(waWebhooksCrudos.recibidoEn)
    .limit(limite);
}

/** El reproceso reinyectó el mensaje con éxito por el mismo camino de ingesta. */
export async function marcarProcesado(db: DB, id: string): Promise<void> {
  await db.update(waWebhooksCrudos).set({ estado: "procesado" }).where(eq(waWebhooksCrudos.id, id));
}

/**
 * Un intento de reproceso falló (el tenant sigue sin resolver, o reventó al
 * reinyectar). Incrementa `intentos`; si llega a `maxIntentos`, se marca
 * "descartado" para que no se reintente para siempre (basura genuina: un
 * payload que nunca va a poder leerse, o un phone_number_id que nunca se dio de
 * alta). Devuelve true si quedó descartado.
 */
export async function marcarIntentoFallido(db: DB, id: string, intentosActuales: number, maxIntentos: number): Promise<boolean> {
  const nuevoIntentos = intentosActuales + 1;
  const descartar = nuevoIntentos >= maxIntentos;
  await db
    .update(waWebhooksCrudos)
    .set({ intentos: nuevoIntentos, estado: descartar ? "descartado" : "pendiente" })
    .where(eq(waWebhooksCrudos.id, id));
  return descartar;
}

/**
 * Purga por retención (ROADMAP F3 + F11): borra `procesado`/`descartado` más
 * viejos que `retencionDias`. Mismo patrón de `purgarJobsHechos` (src/queue/cola.ts):
 * en lotes, sin transacción envolvente, para no retener el lock del índice de
 * `pendiente` más de lo necesario en el pooler de Supabase.
 */
export async function purgarWebhooksCrudos(db: DB, retencionDias = 7, tamanoLote = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = filasDe<{ id: string }>(
      await db.execute(sql`
      DELETE FROM wa_webhooks_crudos
       WHERE id IN (
         SELECT id FROM wa_webhooks_crudos
          WHERE estado IN ('procesado', 'descartado') AND recibido_en < now() - ${retencionDias} * interval '1 day'
          ORDER BY recibido_en ASC
          LIMIT ${tamanoLote}
       )
      RETURNING id
    `),
    );
    total += rows.length;
    if (rows.length < tamanoLote) break;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerta por volumen (ROADMAP F3, punto 4): un pico de `pendiente` es la señal
// temprana de "el caché de tenants está en fallback" (base caída al arrancar) o
// "alguien apuntó mal un webhook". Contador EN MEMORIA (por proceso), no una
// query extra a la tabla en cada descarte — esto corre en la Fase 1 del webhook,
// antes del 200 a Meta, y ya se explicó (ROADMAP F3) que ese camino no debe
// ganar latencia de más. Con varias réplicas cada una cuenta la suya: subestima
// el total real, pero alcanza como señal temprana para el piloto (una réplica
// sola ya dispara la alerta).
// ─────────────────────────────────────────────────────────────────────────────
const ALERTA_VENTANA_MS = Number(process.env.WEBHOOKS_CRUDOS_ALERTA_VENTANA_MIN ?? 5) * 60_000;
const ALERTA_UMBRAL = Number(process.env.WEBHOOKS_CRUDOS_ALERTA_UMBRAL ?? 20);
const ALERTA_COOLDOWN_MS = 15 * 60_000; // no re-alertar antes de 15 min (evita ruido en Sentry)

let ventanaInicio = Date.now();
let contadorVentana = 0;
let ultimaAlertaEn = 0;

function registrarParaAlerta(motivo: MotivoDescarte): void {
  const ahora = Date.now();
  if (ahora - ventanaInicio > ALERTA_VENTANA_MS) {
    ventanaInicio = ahora;
    contadorVentana = 0;
  }
  contadorVentana++;
  if (contadorVentana >= ALERTA_UMBRAL && ahora - ultimaAlertaEn > ALERTA_COOLDOWN_MS) {
    ultimaAlertaEn = ahora;
    capturarError(
      new Error(
        `wa_webhooks_crudos: ${contadorVentana} mensaje(s) descartado(s) en los últimos ${Math.round(ALERTA_VENTANA_MS / 60_000)} min`,
      ),
      { modulo: "webhooksCrudos", motivo },
    );
  }
}

/** Solo para tests: resetea el contador de la ventana de alerta. */
export function _resetAlertaParaTests(): void {
  ventanaInicio = Date.now();
  contadorVentana = 0;
  ultimaAlertaEn = 0;
}
