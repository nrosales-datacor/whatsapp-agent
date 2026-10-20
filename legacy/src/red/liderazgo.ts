import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import { filasDe } from "../db/filas";
import { conSistema } from "../db/alcance";

// ─────────────────────────────────────────────────────────────────────────────
// Líder de schedulers tipo cron (ROADMAP F6, PLAN-ESCALA-MULTITENANT.md).
//
// POR QUÉ: recordatorios, reputación y el reporte de métricas son loops
// periódicos (`iniciarCicloSinSolape`, F12) que recorren TODOS los tenants en
// cada tick — a diferencia de los workers de cola (`src/queue/cola.ts`), no
// tienen un claim atómico POR UNIDAD DE TRABAJO. Con un solo proceso "todo"
// esto nunca fue un problema (solo hay un tick corriendo). Al separar procesos
// web/worker (F6, `ROL=worker` con N réplicas detrás de PM2/un balanceador),
// cada réplica correría el mismo ciclo al mismo tiempo: no duplicaría ENVÍOS
// (esos ya están protegidos por `reclamarRecordatorio`, un CAS por cita+tipo),
// pero sí multiplicaría queries a Postgres y llamadas a APIs externas (Places)
// por N sin ninguna ganancia — carga innecesaria, no un bug de corrección.
//
// DISEÑO: una tabla (`wa_lideres`, ver `src/db/schema.ts`), una fila por
// scheduler (`nombre`), con un lease: `titular` (quién lo tiene) + `vence_en`
// (hasta cuándo). Adquirir o RENOVAR el lease es UNA sola sentencia atómica:
//
//   INSERT ... ON CONFLICT (nombre) DO UPDATE
//     SET titular = <yo>, vence_en = now() + <duración>
//     WHERE wa_lideres.vence_en < now() OR wa_lideres.titular = <yo>
//   RETURNING titular
//
// Solo me vuelvo (o sigo siendo) titular si el lease anterior YA VENCIÓ o ya
// era mío; cualquier otro proceso que corra esta misma sentencia en paralelo
// pierde la carrera en el propio motor de Postgres (no hay un "leer y después
// escribir" en dos pasos separados, que es donde vivirían las carreras). Mismo
// estilo que el resto del repo — SQL puro dentro de una sola sentencia (FOR
// UPDATE SKIP LOCKED en la cola, UPDATE...WHERE...IS NULL en
// `reclamarRecordatorio`) — NUNCA advisory locks de sesión: no son confiables
// contra el pooler de Supabase en modo transacción (`prepare: false`), ver el
// comentario en `src/queue/cola.ts`.
//
// Cada scheduler llama a `intentarLiderazgo` en CADA tick (dentro del `tick`
// que le pasa a `iniciarCicloSinSolape`) con un `titular` fijo por proceso
// (`crypto.randomUUID()`, generado una vez al cargar el módulo) y una duración
// de lease de varias veces su propio intervalo: si el titular se cae (crash,
// `pm2 restart`) el lease vence solo y otra réplica lo toma en su próximo tick,
// sin heartbeat ni quorum aparte.
//
// Sin `DATABASE_URL` (modo memoria/dev) no existe la tabla y no hace falta
// coordinar nada — es, por definición, un solo proceso: `intentarLiderazgo`
// devuelve `true` directo sin tocar la base.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

/**
 * Intenta adquirir o renovar el lease de liderazgo `nombre` para `titular`,
 * extendiéndolo `duracionMs` desde ahora. Devuelve `true` si (y solo si)
 * `titular` es el líder vigente después de este intento.
 */
export async function intentarLiderazgo(db: DB | null, nombre: string, titular: string, duracionMs: number): Promise<boolean> {
  if (!db) return true; // modo memoria: un solo proceso, siempre es el líder.

  const filas = filasDe<{ titular: string }>(
    await conSistema(db, (tx) => tx.execute(sql`
      INSERT INTO wa_lideres (nombre, titular, vence_en)
      VALUES (${nombre}, ${titular}, now() + ${duracionMs} * interval '1 millisecond')
      ON CONFLICT (nombre) DO UPDATE
        SET titular = excluded.titular, vence_en = excluded.vence_en
        WHERE wa_lideres.vence_en < now() OR wa_lideres.titular = excluded.titular
      RETURNING titular
    `),
  ));
  // 0 filas = el UPDATE no cumplió el WHERE (otro titular tiene un lease vigente):
  // ni se insertó ni se actualizó nada, así que no hay nada que devolver.
  return filas.length > 0;
}
