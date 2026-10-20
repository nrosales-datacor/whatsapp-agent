import type { Plan } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit de ingesta por tenant (F10 — PLAN-ESCALA-MULTITENANT.md), en memoria,
// sin dependencias nuevas (mismo espíritu que panel/rateLimitLogin.ts).
//
// POR QUÉ: antes de F10 no había NINGÚN freno en el webhook — un bucle o un bot
// ajeno pegándole al número de un tenant consume la cola global (wa_jobs) y la
// OPENAI_API_KEY compartida sin límite, degradando a los otros 49 tenants del
// proceso (Node es de un solo hilo y el webhook de TODOS los negocios comparte
// event loop y pool). Un rate limit POR TENANT acota el daño a ese negocio.
//
// TOKEN BUCKET, no ventana fija: permite ráfagas normales (2-3 mensajes seguidos
// de un cliente real, E5-a) sin castigarlas, pero frena un caudal sostenido alto.
// `capacidad` tokens de arranque (el burst tolerado), se recargan a `porSeg`
// tokens/segundo hasta el tope de `capacidad`.
//
// QUÉ PASA AL EXCEDERSE: a diferencia del rate limit de login (que devuelve 429 y
// corta), acá el mensaje NUNCA se pierde — eso es lo que garantiza F3
// (`ingerirEntrante` siempre persiste + encola). Lo único que cambia es que el job
// se encola con un `ejecutarDespuesDe` diferido (ver handleWebhook.ts): se degrada
// la LATENCIA de esa respuesta puntual, no la entrega.
// ─────────────────────────────────────────────────────────────────────────────

// Capacidad (burst tolerado) y recarga (sostenido) por plan. Pro tiene más margen:
// negocios con más volumen legítimo de clientes reales. Configurable por env sin
// redeploy de código, mismo criterio que panel/rateLimitLogin.ts.
const CAPACIDAD: Record<Plan, number> = {
  basico: Number(process.env.RATE_LIMIT_INGESTA_BASICO_CAPACIDAD ?? 20),
  pro: Number(process.env.RATE_LIMIT_INGESTA_PRO_CAPACIDAD ?? 60),
};
const RECARGA_POR_SEG: Record<Plan, number> = {
  basico: Number(process.env.RATE_LIMIT_INGESTA_BASICO_POR_SEG ?? 1), // ~60 msj/min sostenido
  pro: Number(process.env.RATE_LIMIT_INGESTA_PRO_POR_SEG ?? 3), // ~180 msj/min sostenido
};

// Cuánto se difiere (ejecutar_despues_de) el job de un mensaje que excedió el
// límite: alcanza para que el bucket se recargue un par de tokens sin ser una
// espera notoria para un cliente real que mandó una ráfaga legítima.
export const RATE_LIMIT_DIFERIR_SEG = Number(process.env.RATE_LIMIT_INGESTA_DIFERIR_SEG ?? 5);

interface Balde {
  tokens: number;
  ultimoRefill: number; // epoch ms
}

const baldes = new Map<string, Balde>();

/**
 * Consume un token del balde del tenant si hay disponible (y lo recarga primero
 * según el tiempo transcurrido). Devuelve `true` si el mensaje entra dentro del
 * límite (procede como siempre), `false` si lo excede (el caller debe diferir el
 * job, nunca descartar el mensaje).
 */
export function permitirIngesta(tenantId: string, plan: Plan): boolean {
  const ahora = Date.now();
  const capacidad = CAPACIDAD[plan];
  const recarga = RECARGA_POR_SEG[plan];

  let b = baldes.get(tenantId);
  if (!b) {
    b = { tokens: capacidad, ultimoRefill: ahora };
    baldes.set(tenantId, b);
  }

  const segTranscurridos = Math.max(0, (ahora - b.ultimoRefill) / 1000);
  b.tokens = Math.min(capacidad, b.tokens + segTranscurridos * recarga);
  b.ultimoRefill = ahora;

  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Purga periódica: sin esto el Map crece sin límite con tenants que ya no mandan
// tráfico (proceso de vida larga bajo PM2). unref() para no mantener vivo el
// proceso solo por este timer (mismo patrón que rateLimitLogin.ts).
const PURGA_INTERVALO_MS = 10 * 60 * 1000;
const temporizadorPurga = setInterval(() => {
  const ahora = Date.now();
  for (const [tenantId, b] of baldes) {
    // Un balde lleno (sin actividad reciente) más de 2 intervalos de purga no
    // aporta nada guardado: la próxima llegada lo recrea igual de lleno.
    if (ahora - b.ultimoRefill > PURGA_INTERVALO_MS * 2) baldes.delete(tenantId);
  }
}, PURGA_INTERVALO_MS);
temporizadorPurga.unref();

/** Solo para tests: el Map es estado de módulo (persiste entre tests del mismo
 *  proceso `tsx --test`), así que cada test que dependa del límite necesita
 *  arrancar desde cero — mismo criterio que rateLimitLogin.ts. */
export function _resetParaTests(): void {
  baldes.clear();
}
