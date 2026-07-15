import { and, eq, lte, sql } from "drizzle-orm";
import { waCampanias } from "../db/schema";
import { filasDe } from "../db/filas";
import { obtenerTenantPorId } from "../config/tenantStore";
import { enviarPlantilla } from "../whatsapp/client";
import { capturarError } from "../observabilidad/sentry";
import { obtenerDb } from "./db";
import { marcarEnviado, marcarFalloOReintentar, marcarOmitidoOptOut, quedanPendientes, reclamarEnvio } from "./cola";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de envío de campañas (ROADMAP C3.2). Mismo esqueleto que
// src/queue/worker.ts (loop con poll + manejo de errores por Sentry), pero
// opera sobre wa_campania_envios (src/campaigns/cola.ts), NO sobre wa_jobs:
// es una cola independiente para no arriesgar B1. Throttle deliberado entre
// envíos (CAMPANIA_ENVIO_INTERVALO_MS, conservador frente al límite más bajo
// de WhatsApp de ~80 msg/s) para que un envío masivo no se sienta "spam".
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = Number(process.env.CAMPANIA_POLL_MS ?? 2000);
const INTERVALO_ENVIO_MS = Number(process.env.CAMPANIA_ENVIO_INTERVALO_MS ?? 1200);

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cuánto esperar antes del próximo tick del loop. Si acabo de procesar un envío,
 * respeto el THROTTLE entre envíos (`intervaloEnvioMs`, conservador frente al
 * límite de WhatsApp); si no había nada, uso el poll normal (`pollMs`). Extraída
 * como función pura para poder probar la política del throttle sin arrancar el loop.
 */
export function elegirEsperaMs(huboEnvio: boolean, intervaloEnvioMs: number, pollMs: number): number {
  return huboEnvio ? intervaloEnvioMs : pollMs;
}

/** Pasa a "enviando" las campañas "programada" cuya hora ya llegó. */
async function activarProgramadas(): Promise<void> {
  const d = obtenerDb();
  await d
    .update(waCampanias)
    .set({ estado: "enviando", iniciadaEn: new Date() })
    .where(and(eq(waCampanias.estado, "programada"), lte(waCampanias.programadaPara, new Date())));
}

/**
 * true si el cliente pidió baja DESPUÉS de armarse el segmento (defensa en
 * profundidad: previsualizarSegmento ya excluye opt-out al materializar, esto
 * cubre la ventana entre esa materialización y el turno real de envío).
 */
async function siguioOptOut(tenantId: string, clienteWa: string): Promise<boolean> {
  const d = obtenerDb();
  const rows = filasDe(
    await d.execute(sql`
    SELECT 1 FROM wa_conversaciones
     WHERE tenant_id = ${tenantId} AND cliente_wa = ${clienteWa} AND opt_out_en IS NOT NULL
     LIMIT 1
  `),
  );
  return rows.length > 0;
}

/** Reclama y procesa UN envío pendiente. Devuelve false si no había ninguno. */
async function procesarUno(): Promise<boolean> {
  const d = obtenerDb();
  const envio = await reclamarEnvio(d);
  if (!envio) return false;

  try {
    if (await siguioOptOut(envio.tenantId, envio.clienteWa)) {
      await marcarOmitidoOptOut(d, envio.id);
    } else {
      const tenant = obtenerTenantPorId(envio.tenantId);
      if (!tenant?.plantillaMarketing) {
        throw new Error("El tenant no tiene (o ya no tiene) una plantilla de marketing configurada");
      }
      const idioma = process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
      await enviarPlantilla(
        tenant,
        envio.clienteWa,
        tenant.plantillaMarketing,
        idioma,
        [envio.clienteNombre, envio.mensaje],
        "marketing",
      );
      await marcarEnviado(d, envio.id);
    }
  } catch (e) {
    console.error(`[campanias] error enviando a ${envio.clienteWa} (campaña ${envio.campaniaId}):`, e);
    await marcarFalloOReintentar(d, envio.id, String(e), envio.intentos);
  }

  // Si ya no quedan envíos pendientes de esta campaña, se da por completada.
  if (!(await quedanPendientes(d, envio.campaniaId))) {
    await d
      .update(waCampanias)
      .set({ estado: "completada", completadaEn: new Date() })
      .where(and(eq(waCampanias.id, envio.campaniaId), eq(waCampanias.estado, "enviando")));
  }
  return true;
}

/** Arranca el worker de campañas. Llamar UNA vez al iniciar el servidor (solo si hay DB). */
export function iniciarCampanias(): void {
  const loop = async () => {
    while (true) {
      try {
        await activarProgramadas();
        const proceso = await procesarUno();
        await dormir(elegirEsperaMs(proceso, INTERVALO_ENVIO_MS, POLL_MS));
      } catch (e) {
        console.error("[campanias] error en el loop:", e);
        capturarError(e, { loop: "campanias" });
        await dormir(POLL_MS);
      }
    }
  };
  loop().catch((e) => {
    console.error("[campanias] el loop murió inesperadamente:", e);
    capturarError(e, { loop: "campanias", fatal: true });
  });
  console.log(`Worker de campañas iniciado (poll cada ${POLL_MS}ms · throttle ${INTERVALO_ENVIO_MS}ms entre envíos).`);
}
