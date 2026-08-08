// Re-export finito: hasta el ROADMAP F7 este módulo mantenía su propio lazy
// singleton de Postgres, mismo precedente que tenía src/campaigns/db.ts (ver
// [[patron-colas-independientes]]). F7 unificó todo en un único pool por
// proceso (`obtenerDb()` en db/client.ts); este archivo queda como alias para
// no tocar el import de rescate/worker.ts.
export { obtenerDb } from "../db/client";
