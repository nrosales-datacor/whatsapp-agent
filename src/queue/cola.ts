import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { waJobs, schema } from "../db/schema";
import { filasDe } from "../db/filas";
import type { PendienteSerializado } from "../types";
import { capturarError } from "../observabilidad/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Cola durable de jobs sobre wa_jobs (ROADMAP B1).
//
// Patrón: claim en transacción corta con FOR UPDATE SKIP LOCKED → trabajo fuera
// de transacción (LLM, segundos) → marcar hecho/error. El reaper reencola jobs
// que quedaron en "procesando" más de umbralSeg (crash a mitad del trabajo).
//
// Semántica: at-least-once. Si el proceso muere después de enviar el WhatsApp
// pero antes de marcarHecho, el job se re-ejecuta → posible respuesta duplicada
// (raro: solo en esa ventana). Aceptado para el piloto.
//
// Pooler-safe: FOR UPDATE SKIP LOCKED corre dentro de db.transaction (postgres.js
// fija una conexión por transacción). No usamos advisory locks de sesión.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

/** Fila de wa_jobs tal como la devuelve el SELECT crudo (snake_case). */
export interface Job {
  id: string;
  tenantId: string;
  intentos: number;
  maxIntentos: number;
  payload: PendienteSerializado;
}

// E5-b (ráfaga): coalescing/debounce por conversación. Si al reclamar un job hay
// otro job PENDIENTE de la MISMA conversación con un `creado_en` más nuevo, este
// job quedó obsoleto — el cliente ya escribió algo más y el mensaje más nuevo va a
// releer el historial completo (E5-a) de todos modos, así que responder a este
// generaría una respuesta duplicada/incoherente. Se marca "reemplazado" (no se
// llama a `responderEntrante`) y seguimos al siguiente candidato.
//
// No agregamos una columna `conversacion_id` a `wa_jobs` (evitamos migración):
// `payload.conv.id` ya viaja en el JSONB de TODOS los jobs (`Pendiente.conv` es
// obligatorio en el tipo), así que alcanza con leerlo vía `payload->'conv'->>'id'`.
// No se agrega índice nuevo: en operación normal la cola pendiente tiene pocas
// filas (se procesa casi en tiempo real), así que un filtro sobre esas pocas filas
// no cambia el plan del claim principal (que sigue usando `wa_jobs_claim_idx`).
//
// Se usa `creado_en` (no `ejecutar_despues_de`) para decidir "más nuevo": el
// backoff de reintentos empuja `ejecutar_despues_de` al futuro sin tocar
// `creado_en`, que refleja el orden real de llegada de los mensajes.
//
// Atomicidad: la comparación pasa DENTRO de la misma transacción que reclama el
// job (antes de marcarlo "procesando"), bajo el lock de `FOR UPDATE SKIP LOCKED`
// del job reclamado. Como la condición es estrictamente "más nuevo que YO", dos
// jobs de la misma conversación no pueden reemplazarse mutuamente: el más viejo
// puede ceder ante el más nuevo, pero el más nuevo nunca encuentra algo "más nuevo
// que él mismo" en ese chequeo.
//
// "reemplazado" es un estado nuevo (columna `estado` es texto libre, sin check
// constraint) que significa "no se respondió a propósito, superseded por un
// mensaje más nuevo de la misma conversación" — distinto de "hecho" (se respondió
// bien) y de "error" (falló). No lo cuenta `profundidadCola` (solo mira
// 'pendiente'), así que no ensucia esa métrica.
const ESTADO_REEMPLAZADO = "reemplazado";

/**
 * Reclama un job pendiente (FOR UPDATE SKIP LOCKED) y lo pone en "procesando".
 * Devuelve null si no hay ninguno listo. Toda la lógica va en una transacción
 * corta para que el lock quede liberado antes de llamar al LLM.
 *
 * Internamente puede reclamar y descartar (marcar "reemplazado") varios jobs
 * obsoletos de una ráfaga antes de devolver el que corresponde procesar (el más
 * nuevo de cada conversación) — ver comentario de E5-b arriba.
 */
export async function reclamarUno(db: DB): Promise<Job | null> {
  while (true) {
    const resultado = await db.transaction(async (tx) => {
      const rows = filasDe<{
        id: string;
        tenant_id: string;
        intentos: number;
        max_intentos: number;
        payload: PendienteSerializado;
        creado_en: Date;
      }>(
        await tx.execute(sql`
        SELECT id, tenant_id, intentos, max_intentos, payload, creado_en
          FROM wa_jobs
         WHERE estado = 'pendiente' AND ejecutar_despues_de <= now()
         ORDER BY ejecutar_despues_de ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      `),
      );

      if (rows.length === 0) return { tipo: "vacio" as const };
      const r = rows[0];

      const conversacionId = r.payload?.conv?.id;
      if (conversacionId) {
        const masNuevo = filasDe<{ id: string }>(
          await tx.execute(sql`
          SELECT id FROM wa_jobs
           WHERE estado = 'pendiente'
             AND payload->'conv'->>'id' = ${conversacionId}
             AND creado_en > ${r.creado_en}
           LIMIT 1
        `),
        );
        if (masNuevo.length > 0) {
          await tx.execute(sql`
            UPDATE wa_jobs
               SET estado = ${ESTADO_REEMPLAZADO}, locked_at = NULL, finalizado_en = now()
             WHERE id = ${r.id}
          `);
          return { tipo: "reemplazado" as const };
        }
      }

      await tx.execute(sql`
        UPDATE wa_jobs
           SET estado = 'procesando', locked_at = now(), intentos = intentos + 1
         WHERE id = ${r.id}
      `);

      return {
        tipo: "job" as const,
        job: {
          id: r.id,
          tenantId: r.tenant_id,
          intentos: r.intentos + 1,
          maxIntentos: r.max_intentos,
          payload: r.payload,
        },
      };
    });

    if (resultado.tipo === "vacio") return null;
    if (resultado.tipo === "reemplazado") continue; // sigue buscando el siguiente candidato
    return resultado.job;
  }
}

/** Marca el job como completado exitosamente. */
export async function marcarHecho(db: DB, id: string): Promise<void> {
  await db
    .update(waJobs)
    .set({ estado: "hecho", finalizadoEn: new Date(), lockedAt: null })
    .where(eq(waJobs.id, id));
}

/** true si ya no quedan reintentos (se marca "error" definitivo). */
export function agotoIntentos(intentos: number, maxIntentos: number): boolean {
  return intentos >= maxIntentos;
}

/** Backoff exponencial en segundos para el próximo reintento: min(2^intentos, 60). */
export function calcularBackoffSeg(intentos: number): number {
  return Math.min(Math.pow(2, intentos), 60);
}

/**
 * Si quedan intentos, reencola con backoff exponencial (min(2^intentos, 60)s).
 * Si se agotaron, marca como "error" definitivo (DLQ, ROADMAP F11) y dispara el
 * chequeo de la alerta por volumen POR TENANT (ver más abajo) — este es el
 * punto exacto en que un job pasa a "error" para siempre, no un reintento
 * intermedio (esos son esperados por el backoff y alertar en cada uno sería
 * ruido, igual que ya documentaba el comentario original de este archivo).
 */
export async function marcarFalloOReintentar(
  db: DB,
  id: string,
  error: string,
  intentos: number,
  maxIntentos: number,
  tenantId: string,
): Promise<void> {
  if (agotoIntentos(intentos, maxIntentos)) {
    await db
      .update(waJobs)
      .set({ estado: "error", ultimoError: error, finalizadoEn: new Date(), lockedAt: null })
      .where(eq(waJobs.id, id));
    registrarErrorDefinitivoParaAlerta(tenantId, error);
    return;
  }
  const retrasoSeg = calcularBackoffSeg(intentos);
  await db.execute(sql`
    UPDATE wa_jobs
       SET estado = 'pendiente',
           ultimo_error = ${error},
           locked_at = NULL,
           ejecutar_despues_de = now() + ${retrasoSeg} * interval '1 second'
     WHERE id = ${id}
  `);
}

/**
 * Reencola jobs zombis: aquellos en "procesando" cuyo locked_at es más viejo que
 * umbralSeg segundos. Cubre el caso de crash a mitad del trabajo.
 * Devuelve la cantidad reencolada (para loguear).
 */
export async function reencolarVencidos(db: DB, umbralSeg = 180): Promise<number> {
  const rows = filasDe<{ id: string }>(
    await db.execute(sql`
    UPDATE wa_jobs
       SET estado = 'pendiente', locked_at = NULL
     WHERE estado = 'procesando'
       AND locked_at < now() - ${umbralSeg} * interval '1 second'
    RETURNING id
  `),
  );
  return rows.length;
}

/**
 * Purga por retención (ROADMAP F11): borra jobs ya "hecho" cuyo finalizado_en
 * sea más viejo que retencionDias. Es la única causa por la que wa_jobs crecía
 * sin límite (medido en producción: 9,4 MB con ~29 filas, la tabla más grande de
 * la base) — cada mensaje deja para siempre una fila con el payload JSONB
 * completo (incluye el snapshot de la conversación con fotos en base64, ver
 * handleWebhook.ts). Solo toca "hecho"; "pendiente"/"procesando"/"error" quedan
 * intactos (el reaper y el DLQ los necesitan vivos).
 *
 * Borra en LOTES (no un DELETE masivo de una sola vez): en el pooler de
 * Supabase, un DELETE grande sobre wa_jobs puede retener por más tiempo el lock
 * que el worker necesita para su propio FOR UPDATE SKIP LOCKED al reclamar, y
 * con el worker concurrente (E7) esa contención empeora. Cada lote es su propia
 * sentencia (sin transacción envolvente), así el lock se libera entre lotes.
 *
 * Devuelve el total de filas borradas (para loguear).
 */
export async function purgarJobsHechos(db: DB, retencionDias = 7, tamanoLote = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = filasDe<{ id: string }>(
      await db.execute(sql`
      DELETE FROM wa_jobs
       WHERE id IN (
         SELECT id FROM wa_jobs
          WHERE estado = 'hecho' AND finalizado_en < now() - ${retencionDias} * interval '1 day'
          ORDER BY finalizado_en ASC
          LIMIT ${tamanoLote}
       )
      RETURNING id
    `),
    );
    total += rows.length;
    // Lote incompleto = ya no queda nada más viejo que el corte: se terminó.
    // Esto además garantiza que el loop no sea infinito.
    if (rows.length < tamanoLote) break;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// DLQ visible (ROADMAP F11, MEDIO-07): antes de esto, un job que agotaba sus
// reintentos quedaba en `estado='error'` sin ninguna forma de verlo — nadie
// sabía cuántos mensajes de qué tenant quedaron sin responder. Estas dos
// funciones son el acceso a datos que consume `GET/POST admin/dlq` en
// `src/panel/router.ts` (superadmin).
// ─────────────────────────────────────────────────────────────────────────────

/** Una fila del DLQ: resumen liviano, sin el `payload` completo (ver `extractoMensaje`). */
export interface JobEnError {
  id: string;
  tenantId: string;
  intentos: number;
  maxIntentos: number;
  ultimoError: string | null;
  creadoEn: Date;
  finalizadoEn: Date | null;
  /**
   * Primeros 200 caracteres de `payload.entrante.texto` (si el job es de clase
   * "texto" y lo tiene) — a propósito NO se trae el `payload` JSONB completo:
   * puede cargar el historial de conversación entero y, en filas legadas
   * previas a F9, fotos en base64 (varios MB). Extraído con `->>` en SQL para
   * no tener que traer y parsear el JSON completo del lado de Node tampoco.
   */
  extractoMensaje: string | null;
}

/**
 * Lista los jobs en `estado='error'` (DLQ), más recientes primero DENTRO de
 * cada tenant. El agrupado por tenant lo arma el caller (router.ts): acá se
 * devuelve la lista plana, ordenada para que agrupar sea trivial.
 */
export async function listarJobsEnError(db: DB, limite = 500): Promise<JobEnError[]> {
  const rows = filasDe<{
    id: string;
    tenant_id: string;
    intentos: number;
    max_intentos: number;
    ultimo_error: string | null;
    creado_en: Date;
    finalizado_en: Date | null;
    extracto: string | null;
  }>(
    await db.execute(sql`
    SELECT id, tenant_id, intentos, max_intentos, ultimo_error, creado_en, finalizado_en,
           LEFT(payload -> 'entrante' ->> 'texto', 200) AS extracto
      FROM wa_jobs
     WHERE estado = 'error'
     ORDER BY tenant_id ASC, finalizado_en DESC NULLS LAST
     LIMIT ${limite}
  `),
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    intentos: r.intentos,
    maxIntentos: r.max_intentos,
    ultimoError: r.ultimo_error,
    creadoEn: r.creado_en,
    finalizadoEn: r.finalizado_en,
    extractoMensaje: r.extracto,
  }));
}

/**
 * Reencola un job del DLQ: lo vuelve a "pendiente" para que el worker lo
 * reclame de nuevo. Solo actúa sobre jobs en `estado='error'` — protegido con
 * un `WHERE estado = 'error'` en el propio UPDATE, así un reencolado sobre un
 * job que ya no está en error (otro operador ya lo reencoló, o el worker lo
 * tomó por otra vía) es un no-op atómico, no una condición de carrera.
 *
 * Criterio: resetea `intentos` a 0 (no lo deja en `maxIntentos`). Un job en el
 * DLQ llegó ahí porque agotó reintentos contra una causa que, para que alguien
 * lo reencole a mano, ya se asume resuelta del lado operativo (ej. se
 * reconectó Google Calendar, se corrigió una plantilla). Dejarlo con
 * `intentos = maxIntentos` lo mandaría directo de vuelta a "error" ante el
 * primer fallo transitorio nuevo, sin darle el mismo margen de reintentos que
 * tuvo cualquier job normal — reencolar sin resetear sería casi equivalente a
 * no reencolar. También limpia `ultimoError` y `finalizadoEn` (vuelve a ser un
 * job "vivo", no uno terminado) y fija `ejecutar_despues_de = now()` para que
 * el worker lo tome en el próximo poll, sin esperar ningún backoff.
 *
 * Devuelve true si reencoló algo, false si el id no existe o no estaba en error.
 */
export async function reencolarJobError(db: DB, id: string): Promise<boolean> {
  const rows = filasDe<{ id: string }>(
    await db.execute(sql`
    UPDATE wa_jobs
       SET estado = 'pendiente',
           intentos = 0,
           ultimo_error = NULL,
           finalizado_en = NULL,
           locked_at = NULL,
           ejecutar_despues_de = now()
     WHERE id = ${id} AND estado = 'error'
    RETURNING id
  `),
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerta por volumen POR TENANT (ROADMAP F11, punto 3) cuando jobs de un mismo
// tenant agotan reintentos seguido — señal de que ESE negocio se quedó sin
// respuestas (integración caída del lado del tenant, plantilla rechazada,
// etc.), a diferencia del contador GLOBAL de F3 (`db/webhooksCrudos.ts`), que
// mide un problema del sistema entero. Un tenant con problemas no debe
// diluirse en el promedio de los demás 49.
//
// Mismo patrón que F3: contador en memoria por proceso, ventana deslizante y
// cooldown para no floodear Sentry — acá con un `Map<tenantId, …>` en vez de
// un único contador. Reemplaza el `capturarError` que antes mandaba
// `src/queue/worker.ts` por CADA job que agotaba intentos (ver el commit de
// F11): con 50 tenants ese `capturarError` por-job es exactamente el ruido que
// este patrón evita, y el job individual ya queda visible en el DLQ
// (`listarJobsEnError`) sin necesidad de generar un evento de Sentry por cada
// uno.
// ─────────────────────────────────────────────────────────────────────────────
const DLQ_ALERTA_VENTANA_MS = Number(process.env.DLQ_ALERTA_VENTANA_MIN ?? 5) * 60_000;
const DLQ_ALERTA_UMBRAL = Number(process.env.DLQ_ALERTA_UMBRAL ?? 5);
const DLQ_ALERTA_COOLDOWN_MS = 15 * 60_000; // no re-alertar antes de 15 min por tenant (mismo valor que F3)

interface ContadorAlertaTenant {
  ventanaInicio: number;
  contador: number;
  ultimaAlertaEn: number;
}
const contadoresErrorPorTenant = new Map<string, ContadorAlertaTenant>();

// capturarError es no-op sin SENTRY_DSN (ver src/observabilidad/sentry.ts), así
// que en tests (sin DSN configurado) no hay forma de observar "se llamó a
// Sentry" desde afuera. Este contador es la señal de test-only de que la
// condición de umbral+cooldown SE CUMPLIÓ (se llegó a llamar a capturarError),
// independiente de si Sentry está configurado o no.
let alertasDisparadasParaTests = 0;

function registrarErrorDefinitivoParaAlerta(tenantId: string, ultimoError: string): void {
  const ahora = Date.now();
  let c = contadoresErrorPorTenant.get(tenantId);
  if (!c || ahora - c.ventanaInicio > DLQ_ALERTA_VENTANA_MS) {
    c = { ventanaInicio: ahora, contador: 0, ultimaAlertaEn: c?.ultimaAlertaEn ?? 0 };
    contadoresErrorPorTenant.set(tenantId, c);
  }
  c.contador++;
  if (c.contador >= DLQ_ALERTA_UMBRAL && ahora - c.ultimaAlertaEn > DLQ_ALERTA_COOLDOWN_MS) {
    c.ultimaAlertaEn = ahora;
    alertasDisparadasParaTests++;
    capturarError(
      new Error(
        `wa_jobs (DLQ): el tenant ${tenantId} tiene ${c.contador} job(s) en error definitivo en los últimos ${Math.round(DLQ_ALERTA_VENTANA_MS / 60_000)} min`,
      ),
      { modulo: "cola", tenantId, ultimoError },
    );
  }
}

/** Solo para tests: resetea los contadores de la alerta por tenant. */
export function _resetAlertaDlqParaTests(): void {
  contadoresErrorPorTenant.clear();
  alertasDisparadasParaTests = 0;
}

/** Solo para tests: cuántas veces se cruzó el umbral+cooldown y se llamó a capturarError. */
export function _contarAlertasDlqParaTests(): number {
  return alertasDisparadasParaTests;
}

/** Solo para tests: umbral vigente (para no hardcodear el default en los tests). */
export function _umbralAlertaDlqParaTests(): number {
  return DLQ_ALERTA_UMBRAL;
}
