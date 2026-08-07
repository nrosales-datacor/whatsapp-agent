import { and, eq, lte, sql } from "drizzle-orm";
import { waCampanias } from "../db/schema";
import { filasDe } from "../db/filas";
import { obtenerTenantPorId } from "../config/tenantStore";
import { enviarPlantilla } from "../whatsapp/client";
import { capturarError } from "../observabilidad/sentry";
import { obtenerDb } from "./db";
import {
  marcarEnviado,
  marcarFalloOReintentar,
  marcarOmitidoOptOut,
  purgarEnviosFinalizados,
  quedanPendientes,
  reclamarEnvio,
} from "./cola";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de envío de campañas (ROADMAP C3.2). Mismo esqueleto que
// src/queue/worker.ts (loop con poll + manejo de errores por Sentry), pero
// opera sobre wa_campania_envios (src/campaigns/cola.ts), NO sobre wa_jobs:
// es una cola independiente para no arriesgar B1. Throttle deliberado entre
// envíos (CAMPANIA_ENVIO_INTERVALO_MS, conservador frente al límite más bajo
// de WhatsApp de ~80 msg/s) para que un envío masivo no se sienta "spam" —
// pero POR TENANT (F8, PLAN-ESCALA-MULTITENANT), no global: ver
// `proximoEnvioPermitido` más abajo.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = Number(process.env.CAMPANIA_POLL_MS ?? 2000);
const INTERVALO_ENVIO_MS = Number(process.env.CAMPANIA_ENVIO_INTERVALO_MS ?? 1200);
// Retención y purga (ROADMAP F11): mismos nombres de env que src/queue/worker.ts
// (un solo par de variables para las tres colas, un solo dial para el operador),
// pero cada worker las lee y las aplica de forma independiente — mismo patrón
// que el resto de esta cola (ver [[patron-colas-independientes]]).
const JOBS_RETENCION_DIAS = Number(process.env.JOBS_RETENCION_DIAS ?? 7);
const PURGA_INTERVAL_MS = Number(process.env.JOBS_PURGA_INTERVALO_MIN ?? 60) * 60_000;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Throttle POR TENANT (F8, PLAN-ESCALA-MULTITENANT), no global: el límite real
 * de Meta es por número de WhatsApp (= por tenant), así que frenar a TODOS los
 * tenants porque UNO acaba de enviar es injusto (el resto espera sin motivo) y
 * más lento de lo necesario (dos tenants pueden enviar en paralelo sin pisarse).
 * Mapa en memoria tenantId → epoch ms del próximo envío permitido para ÉL.
 * Vive en el proceso del worker (un solo worker por deploy); si se corren
 * varias réplicas cada una lleva su propio mapa — el límite de Meta igual se
 * respeta porque cada réplica solo procesa lo que alcanza a reclamar.
 */
const proximoEnvioPermitido = new Map<string, number>();

/**
 * Ms que hay que esperar ANTES de enviar al tenant `tenantId` ya mismo (0 si no
 * hace falta esperar). Función pura (recibe el mapa y "ahora" como parámetros)
 * para poder probar la política de throttle sin temporizadores reales.
 */
export function esperaThrottleTenant(mapa: ReadonlyMap<string, number>, tenantId: string, ahora: number): number {
  return Math.max(0, (mapa.get(tenantId) ?? 0) - ahora);
}

/** Registra que el tenant `tenantId` acaba de consumir su turno de envío: el próximo para ÉL se habilita recién tras `intervaloMs`. */
export function registrarEnvioTenant(mapa: Map<string, number>, tenantId: string, ahora: number, intervaloMs: number): void {
  mapa.set(tenantId, ahora + intervaloMs);
}

/**
 * Cuánto esperar antes del PRÓXIMO tick del loop externo. El throttle real
 * (por tenant) ya se aplicó dentro de `procesarUno` si hacía falta; acá solo
 * se evita golpear la DB en un loop apretado cuando la cola está vacía: si
 * hubo envío, se reintenta ya mismo (puede haber otro tenant listo sin
 * esperar); si no había nada, se usa el poll normal.
 */
export function elegirEsperaMs(huboEnvio: boolean, pollMs: number): number {
  return huboEnvio ? 0 : pollMs;
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

  // Throttle por tenant (F8): si a ESTE tenant le tocó turno hace menos de
  // INTERVALO_ENVIO_MS, se espera solo por él — otro tenant reclamado en la
  // próxima vuelta del loop puede no necesitar esperar nada.
  const espera = esperaThrottleTenant(proximoEnvioPermitido, envio.tenantId, Date.now());
  if (espera > 0) await dormir(espera);

  try {
    if (await siguioOptOut(envio.tenantId, envio.clienteWa)) {
      await marcarOmitidoOptOut(d, envio.id);
    } else {
      const tenant = obtenerTenantPorId(envio.tenantId);
      if (!tenant?.plantillaMarketing) {
        throw new Error("El tenant no tiene (o ya no tiene) una plantilla de marketing configurada");
      }
      // Idioma por tenant (E8/BLOQ-06): un cliente puede aprobar sus plantillas en
      // "es_MX" y otro en "es" — no es fail-closed (no es un secreto), solo un
      // default en cascada: tenant → env global → "es".
      const idioma = tenant.plantillaIdioma ?? process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
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

  // Se registra el turno de ESTE tenant tanto si el envío salió bien como si
  // falló: un reintento también consume la cuota de llamadas a la API de Meta.
  registrarEnvioTenant(proximoEnvioPermitido, envio.tenantId, Date.now(), INTERVALO_ENVIO_MS);

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
        await dormir(elegirEsperaMs(proceso, POLL_MS));
      } catch (e) {
        console.error("[campanias] error en el loop:", e);
        capturarError(e, { loop: "campanias" });
        await dormir(POLL_MS);
      }
    }
  };

  // Loop de purga (ROADMAP F11), intervalo propio y espaciado, igual criterio
  // que src/queue/worker.ts: un fallo se loguea y va a Sentry, nunca tumba el loop.
  const loopPurga = async () => {
    while (true) {
      await dormir(PURGA_INTERVAL_MS);
      try {
        const n = await purgarEnviosFinalizados(obtenerDb(), JOBS_RETENCION_DIAS);
        if (n > 0) console.log(`[campanias] purga: ${n} envío(s) de campaña finalizada borrado(s)`);
      } catch (e) {
        console.error("[campanias] purga error:", e);
        capturarError(e, { loop: "purga-campanias" });
      }
    }
  };

  loop().catch((e) => {
    console.error("[campanias] el loop murió inesperadamente:", e);
    capturarError(e, { loop: "campanias", fatal: true });
  });
  loopPurga().catch((e) => {
    console.error("[campanias] loop de purga terminó inesperadamente:", e);
    capturarError(e, { loop: "purga-campanias", fatal: true });
  });
  console.log(`Worker de campañas iniciado (poll cada ${POLL_MS}ms · throttle ${INTERVALO_ENVIO_MS}ms entre envíos, por tenant).`);
}
