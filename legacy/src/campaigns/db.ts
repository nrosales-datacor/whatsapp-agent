// Re-export finito: hasta el ROADMAP F7 este módulo mantenía su propio lazy
// singleton de Postgres, separado del que armaba server.ts para el repositorio
// principal y del de tenantStore.ts. F7 unificó todo en un único pool por
// proceso (`obtenerDb()` en db/client.ts); este archivo queda como alias para
// no tocar los imports de campaigns/worker.ts, segmentos.ts y campanias.ts.
export { obtenerDb } from "../db/client";
