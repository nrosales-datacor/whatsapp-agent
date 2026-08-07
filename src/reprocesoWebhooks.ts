import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./db/schema";
import type { Repositorio } from "./types";
import { obtenerTenantPorPhoneNumberId } from "./config/tenantStore";
import { ingerirEntrante } from "./handleWebhook";
import { listarPendientes, marcarIntentoFallido, marcarProcesado } from "./db/webhooksCrudos";

// ─────────────────────────────────────────────────────────────────────────────
// Reproceso de `wa_webhooks_crudos` (ROADMAP F3, punto 3).
//
// Vive en su PROPIO módulo (no en tenantStore.ts ni en handleWebhook.ts) para
// evitar un ciclo de imports: tenantStore.recargar() es quien dispara el
// reproceso (un negocio recién dado de alta debe recuperar los mensajes que
// llegaron antes de existir), pero tenantStore NO puede importar handleWebhook
// (que a su vez importa cosas que dependen de tenantStore). En vez de eso,
// tenantStore expone un registro de callbacks genérico (`alRecargar`, sin saber
// nada de webhooks) y es `server.ts` quien, al arrancar, conecta ambas puntas:
//   tenantStore.alRecargar(() => reprocesarPendientes(db, repo))
// Así el grafo de imports queda: server.ts → reprocesoWebhooks.ts → handleWebhook.ts
// y server.ts → tenantStore.ts, sin que tenantStore ni handleWebhook se conozcan
// entre sí por este motivo.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

const MAX_INTENTOS_REPROCESO = Number(process.env.WEBHOOKS_CRUDOS_MAX_INTENTOS ?? 5);

export interface ResultadoReproceso {
  procesados: number;
  descartados: number;
  siguenPendientes: number;
}

/**
 * Barre los `pendiente` de `wa_webhooks_crudos` y reintenta cada uno:
 *   - si su `phone_number_id` YA resuelve en el caché de tenants (o el motivo
 *     fue "no_parseable" y el reintento igual tiene sentido: reinyectar por el
 *     mismo camino de ingesta puede simplemente confirmar que sigue sin poder
 *     leerse), llama a `ingerirEntrante` con el payload guardado — el MISMO
 *     camino que un mensaje que acaba de llegar. Si eso encola el job (o ya
 *     estaba encolado, dedup por waMessageId), la fila queda "procesado".
 *   - si sigue sin resolver o vuelve a fallar, incrementa `intentos`; al llegar
 *     a `MAX_INTENTOS_REPROCESO` la fila queda "descartado" (basura genuina: un
 *     payload que nunca podrá leerse, o un phone_number_id que nunca se va a
 *     dar de alta) para no reintentar para siempre.
 *
 * Se llama tras cada `recargar()` del tenantStore (alta de negocio, refresco
 * periódico, recarga on-demand ante un pnid nuevo): son los momentos en los que
 * el caché puede haber incorporado justo el tenant que faltaba.
 */
export async function reprocesarPendientes(db: DB, repo: Repositorio): Promise<ResultadoReproceso> {
  const pendientes = await listarPendientes(db);
  let procesados = 0;
  let descartados = 0;

  for (const fila of pendientes) {
    // Solo vale la pena reinyectar cuando el phone_number_id AHORA resuelve: si
    // el motivo fue "no_parseable" casi siempre no lo tenemos (phoneNumberId
    // null), y reinyectar el MISMO payload sin que nada haya cambiado solo
    // repetiría el mismo fallo — y además volvería a llamar a `guardarCrudo`,
    // que insertaría una fila NUEVA (waMessageId null no choca con nada) en vez
    // de resolver esta. Por eso esas filas se cuentan como intento fallido
    // directamente, sin pasar por `ingerirEntrante`.
    const resuelve = !!fila.phoneNumberId && !!obtenerTenantPorPhoneNumberId(fila.phoneNumberId);
    if (!resuelve) {
      const descartada = await marcarIntentoFallido(db, fila.id, fila.intentos, MAX_INTENTOS_REPROCESO);
      if (descartada) descartados++;
      continue;
    }

    try {
      // Mismo camino que un mensaje que acaba de llegar: parsea de nuevo, resuelve
      // el tenant (que ahora sí existe), persiste y encola — o no hace nada si el
      // mensaje ya se procesó por otra vía (dedup por waMessageId). Pasarle `db`
      // de nuevo es necesario para que, si pese a todo sigue sin poder procesarse,
      // `ingerirEntrante` sepa dónde registrar el nuevo intento fallido.
      await ingerirEntrante(fila.payload, repo, db);
      await marcarProcesado(db, fila.id);
      procesados++;
    } catch (e) {
      console.error(`[reproceso] la fila ${fila.id} de wa_webhooks_crudos volvió a fallar:`, e);
      const descartada = await marcarIntentoFallido(db, fila.id, fila.intentos, MAX_INTENTOS_REPROCESO);
      if (descartada) descartados++;
    }
  }

  return { procesados, descartados, siguenPendientes: pendientes.length - procesados - descartados };
}
