// ─────────────────────────────────────────────────────────────────────────────
// Timeouts de red (auditoría 2026-07-27, BLOQUEANTE-03).
//
// POR QUÉ ESTE ARCHIVO: ni `fetch` ni el SDK de OpenAI traen un timeout razonable
// por default. `fetch` (undici) espera ~300 s por los headers; el SDK de OpenAI
// espera 600 s y reintenta 2 veces → hasta 30 MINUTOS colgado en una sola llamada.
//
// Eso, combinado con el worker SERIAL (`src/queue/worker.ts` procesa un job a la
// vez para todos los tenants), es head-of-line blocking global: una llamada
// colgada del cliente A congela la cola de los clientes B, C y D — todos dejan de
// recibir respuestas y el único síntoma es `cola pendiente=N` creciendo en los
// logs. Por eso TODA salida a la red del proyecto lleva timeout explícito.
//
// Los valores se pueden ajustar por .env sin tocar código (útil si un proveedor
// se pone lento en producción), pero los defaults son deliberadamente cortos:
// más vale fallar rápido y que la cola reintente que bloquear a todos.
// ─────────────────────────────────────────────────────────────────────────────

function msDeEnv(nombre: string, porDefecto: number): number {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

/** Llamadas al chat de OpenAI (el turno del agente). Generoso para gpt-4o-mini. */
export const TIMEOUT_OPENAI_MS = msDeEnv("OPENAI_TIMEOUT_MS", 20_000);

/**
 * Transcripción de notas de voz (Whisper). Más holgado que el chat: sube el
 * archivo de audio, así que depende del ancho de banda del droplet.
 */
export const TIMEOUT_OPENAI_AUDIO_MS = msDeEnv("OPENAI_AUDIO_TIMEOUT_MS", 45_000);

/** Reintentos del SDK de OpenAI. 1 (no 2): la cola durable ya reintenta el job. */
export const OPENAI_MAX_REINTENTOS = msDeEnv("OPENAI_MAX_REINTENTOS", 1);

/** Graph API de Meta (envíos, plantillas, suscripción de webhooks). */
export const TIMEOUT_GRAPH_MS = msDeEnv("GRAPH_TIMEOUT_MS", 15_000);

/** Descarga de media de WhatsApp (audios y fotos: bytes, no JSON). */
export const TIMEOUT_MEDIA_MS = msDeEnv("MEDIA_TIMEOUT_MS", 30_000);

/** APIs de Google (Calendar, OAuth de la service account, Places). */
export const TIMEOUT_GOOGLE_MS = msDeEnv("GOOGLE_TIMEOUT_MS", 15_000);

/**
 * Señal de abort para pasarle a `fetch`. Envuelta en una función (en vez de usar
 * `AbortSignal.timeout` suelto en cada llamada) para que el timeout quede
 * documentado en un solo lugar y para poder loguear/ajustar la política después.
 */
export function conTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
