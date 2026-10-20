import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/scope";
import { withSystem } from "../db/scope";
import { rowsOf } from "../db/rows";
import { startNonOverlappingLoop, type Loop, type LoopOptions } from "./scheduler";

// ─────────────────────────────────────────────────────────────────────────────
// Líder de schedulers tipo cron.
//
// POR QUÉ: recordatorios, reportes y detectores son loops periódicos
// (`startNonOverlappingLoop`) que recorren TODOS los negocios en cada tick — a
// diferencia de los workers de cola, no tienen un claim atómico POR UNIDAD DE TRABAJO.
// Con un solo proceso `ROLE=all` esto nunca es un problema (solo hay un tick corriendo).
// Con varias réplicas `ROLE=worker`, cada una correría el mismo ciclo al mismo tiempo:
// multiplicaría queries a Postgres y llamadas a APIs externas por N sin ninguna ganancia.
//
// DISEÑO: una tabla (`leader_leases`, ver src/platform/db/schema.ts), una fila por
// scheduler (`name`), con un lease: `holder` (quién lo tiene) + `expires_at` (hasta
// cuándo). Adquirir o RENOVAR el lease es UNA sola sentencia atómica:
//
//   INSERT ... ON CONFLICT (name) DO UPDATE
//     SET holder = <yo>, expires_at = now() + <duración>
//     WHERE leader_leases.expires_at < now() OR leader_leases.holder = <yo>
//   RETURNING holder
//
// Solo me vuelvo (o sigo siendo) titular si el lease anterior YA VENCIÓ o ya era mío;
// cualquier otro proceso que corra la misma sentencia en paralelo pierde la carrera en el
// propio motor de Postgres (no hay un "leer y después escribir" en dos pasos, que es
// donde vivirían las carreras). NUNCA advisory locks de sesión: no son confiables contra
// el pooler de Supabase en modo transacción (`prepare: false`).
//
// Cada scheduler intenta el lease en CADA tick con un `holder` fijo por proceso y una
// duración de varias veces su propio intervalo: si el titular se cae (crash,
// `pm2 restart`) el lease vence solo y otra réplica lo toma en su próximo tick, sin
// heartbeat ni quorum aparte.
// ─────────────────────────────────────────────────────────────────────────────

/** Titular de este proceso: un id al azar generado al cargar el módulo (no es un usuario ni un negocio). */
export const PROCESS_HOLDER = randomUUID();

/**
 * Intenta adquirir o renovar el lease `name` para `holder`, extendiéndolo `durationMs`
 * desde ahora. Devuelve `true` si (y solo si) `holder` es el líder vigente después del
 * intento. `db = null` (sin base: un solo proceso por definición) siempre gana.
 */
export async function tryAcquireLease(db: Executor | null, name: string, holder: string, durationMs: number): Promise<boolean> {
  if (!db) return true;

  const rows = rowsOf<{ holder: string }>(
    await withSystem(db, (tx) => tx.execute(sql`
      INSERT INTO leader_leases (name, holder, expires_at)
      VALUES (${name}, ${holder}, now() + ${durationMs} * interval '1 millisecond')
      ON CONFLICT (name) DO UPDATE
        SET holder = excluded.holder, expires_at = excluded.expires_at
        WHERE leader_leases.expires_at < now() OR leader_leases.holder = excluded.holder
      RETURNING holder
    `)),
  );
  // 0 filas = el UPDATE no cumplió el WHERE (otro titular tiene un lease vigente): ni se
  // insertó ni se actualizó nada, así que no hay nada que devolver.
  return rows.length > 0;
}

export interface LeaderLoopOptions extends LoopOptions {
  db: Executor | null;
  /** Nombre del lease (uno por scheduler). Por defecto, `label`. */
  leaseName?: string;
  /** Duración del lease; por defecto 3 intervalos (si el líder muere, otro lo toma al vencer). */
  leaseMs?: number;
}

/**
 * `startNonOverlappingLoop` + lease de liderazgo: el tick solo corre en el proceso que
 * tiene el lease vigente; en las demás réplicas el tick es un no-op.
 */
export function startLeaderLoop(options: LeaderLoopOptions): Loop {
  const { db, leaseName = options.label, leaseMs = options.intervalMs * 3, tick, ...loop } = options;
  return startNonOverlappingLoop({
    ...loop,
    tick: async () => {
      if (!(await tryAcquireLease(db, leaseName, PROCESS_HOLDER, leaseMs))) return;
      await tick();
    },
  });
}
