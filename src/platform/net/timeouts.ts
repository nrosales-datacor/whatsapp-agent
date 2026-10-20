// ─────────────────────────────────────────────────────────────────────────────
// Timeouts de red.
//
// POR QUÉ ESTE ARCHIVO: ni `fetch` ni los SDKs de proveedores traen un timeout razonable
// por default. `fetch` (undici) espera ~300 s por los headers; el SDK de OpenAI espera
// 600 s y reintenta 2 veces → hasta 30 MINUTOS colgado en una sola llamada. Con un worker
// que atiende a varios negocios eso es head-of-line blocking global: una llamada colgada
// del negocio A congela la cola de B, C y D. Por eso TODA salida a la red del proyecto
// lleva timeout explícito, y los valores se documentan acá, en un solo lugar.
//
// Se pueden ajustar por .env sin tocar código (útil si un proveedor se pone lento), pero
// los defaults son deliberadamente cortos: más vale fallar rápido y que la cola
// reintente que bloquear a todos. Los timeouts de OpenAI, Graph (WhatsApp) y Google
// vuelven con el módulo WhatsApp IA (I2); la versión anterior quedó en la copia de
// referencia del dominio viejo (src/red/timeouts.ts dentro de la carpeta legacy).
// ─────────────────────────────────────────────────────────────────────────────

/** Lee un entero positivo de la env, o `fallback` si falta o no es válido. */
export function msFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Supabase Storage: subida de archivos y firma de URLs de corta vida. */
export const STORAGE_TIMEOUT_MS = msFromEnv("STORAGE_TIMEOUT_MS", 20_000);

/**
 * Señal de abort para pasarle a `fetch`. Envuelta en una función (en vez de usar
 * `AbortSignal.timeout` suelto en cada llamada) para que el timeout quede documentado en
 * un solo lugar y para poder loguear/ajustar la política después.
 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
