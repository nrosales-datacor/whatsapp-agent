import { eq } from "drizzle-orm";
import { withSystem, type Executor } from "../../src/platform/db/scope";
import { jobs } from "../../src/platform/queue/schema";

// Utilidades compartidas de los tests de la cola (test/reliability/queue*.test.ts).

/** Espera a que `cond` sea true (polling cada `stepMs`); falla con `label` si vence `timeoutMs`. */
export async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: venció esperando "${label}"`);
    await sleep(stepMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fila completa de un job (contexto de sistema). */
export async function getJob(db: Executor, id: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
  if (!row) throw new Error(`no existe el job ${id}`);
  return row;
}

/** Todos los jobs (contexto de sistema). */
export function allJobs(db: Executor) {
  return withSystem(db, (tx) => tx.select().from(jobs));
}

/**
 * Silencia console.log/warn/error mientras corre el archivo (el worker loguea una línea
 * JSON por evento). Devuelve la función que los restaura.
 */
export function silenceConsole(): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}
