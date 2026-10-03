import type { Cita, Tenant } from "../types";
import { listarTenants } from "../config/tenantStore";
import { tenantPuede } from "../billing/planes";
import { enviarLista, enviarPlantilla, opcionHorario } from "../whatsapp/client";
import { espaciosDisponibles } from "../booking/availability";
import { hoyEnTz } from "../booking/gestionCitas";
import { capturarError } from "../observabilidad/sentry";
import { obtenerDb } from "./db";
import { enmascararTelefono } from "../observabilidad/privacidad";
import {
  citasDelDia,
  enModoHumano,
  marcarOptOut,
  nombreClienteAprox,
  purgarCotizacionesFinalizadas,
  reclamarToque1,
  reclamarToque2,
  revertirToque1,
  revertirToque2,
  siguioOptOut,
  type CandidatoToque,
} from "./cola";

// ─────────────────────────────────────────────────────────────────────────────
// Worker del rescate de cotizaciones abandonadas (ROADMAP Carril D, 1.1). Mismo
// esqueleto que src/campaigns/worker.ts: loop con poll + throttle entre envíos +
// manejo de errores por Sentry, pero sobre wa_cotizaciones (src/rescate/cola.ts).
//
// Por tenant, cada tick procesa hasta RESCATE_MAX_POR_TICK toques listos (F8:
// tope, no drenado total, para que el `for` sobre tenants siempre avance):
//   • Toque 1 (dentro de 24h): lista tocable con los próximos horarios libres.
//   • Toque 2 (día siguiente, fuera de 24h): plantilla de Meta aprobada.
// Antes de mandar cualquiera, revisa opt-out y modo humano (reglas duras del plan).
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = Number(process.env.RESCATE_POLL_MS ?? 5000);
const INTERVALO_ENVIO_MS = Number(process.env.RESCATE_ENVIO_INTERVALO_MS ?? 1200);
// Tope por tick (F8, PLAN-ESCALA-MULTITENANT): antes, `procesarTenant` drenaba
// TODOS los toques listos de un tenant (`while` sin límite) antes de que el
// `for` sobre listarTenants() le diera un turno al siguiente — un tenant con
// cientos de cotizaciones abandonadas podía monopolizar el worker mientras los
// demás esperaban. Con este tope, cada tenant procesa como mucho
// RESCATE_MAX_POR_TICK candidatos de toque1 y otros tantos de toque2 por
// vuelta del `for`, y el resto queda pendiente para la vuelta siguiente.
const RESCATE_MAX_POR_TICK = Number(process.env.RESCATE_MAX_POR_TICK ?? 5);
// Horas entre el toque1 y el toque2 (día siguiente, ya fuera de la ventana de 24h).
const TOQUE2_HORAS_DESPUES = Number(process.env.RESCATE_TOQUE2_HORAS_DESPUES ?? 24);
// Cuántos días adelante se busca un hueco libre para ofrecer en el toque1.
const DIAS_BUSQUEDA_HORARIO = 14;
const MAX_FILAS_LISTA = 10;
// Retención y purga (ROADMAP F11): mismos nombres de env que src/queue/worker.ts
// y src/campaigns/worker.ts (un solo dial de retención para el operador), leídos
// y aplicados de forma independiente acá, mismo patrón que el resto de esta cola.
const JOBS_RETENCION_DIAS = Number(process.env.JOBS_RETENCION_DIAS ?? 7);
const PURGA_INTERVAL_MS = Number(process.env.JOBS_PURGA_INTERVALO_MIN ?? 60) * 60_000;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Suma días a una fecha "YYYY-MM-DD" (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaMasDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Busca el próximo día (desde hoy, hasta DIAS_BUSQUEDA_HORARIO días adelante) con
 * espacios libres para el servicio. null si no encuentra ninguno en ese rango.
 */
async function proximaFechaConHorarios(
  tenant: Tenant,
  servicioId: string,
): Promise<{ fecha: string; libres: string[] } | null> {
  const db = obtenerDb();
  let fecha = hoyEnTz(tenant.timezone);
  for (let i = 0; i < DIAS_BUSQUEDA_HORARIO; i++) {
    const citas = await citasDelDia(db, tenant.id, fecha);
    // espaciosDisponibles solo lee estado/hora/servicioId de cada cita (ver
    // src/booking/availability.ts); el cast es seguro porque citasDelDia ya trae
    // exactamente esos tres campos.
    const libres = espaciosDisponibles(tenant, fecha, servicioId, citas as unknown as Cita[]);
    if (libres.length > 0) return { fecha, libres };
    fecha = fechaMasDias(fecha, 1);
  }
  return null;
}

function nombreServicio(tenant: Tenant, servicioId: string): string {
  return tenant.servicios.find((s) => s.id === servicioId)?.nombre ?? servicioId;
}

/** Texto del toque1 (o el editado por el dueño en "Mi negocio" + placeholders). */
function construirTextoToque1(tenant: Tenant, cand: CandidatoToque, libresQueSeMuestran: number): string {
  const servicio = nombreServicio(tenant, cand.servicioId);
  const plantilla =
    tenant.rescateToque1Texto ||
    `¡Hola! 👋 ¿Te guardo el espacio para el ${"{servicio}"} (${"{monto}"})? Me quedan ${"{n}"} horarios libres.`;
  return plantilla
    .replaceAll("{servicio}", servicio)
    .replaceAll("{monto}", `${tenant.moneda}${cand.monto.toLocaleString("es-CR")}`)
    .replaceAll("{n}", String(libresQueSeMuestran));
}

/** Intenta procesar UN candidato al toque1 de un tenant. Devuelve false si no había ninguno. */
async function procesarToque1(tenant: Tenant): Promise<boolean> {
  const db = obtenerDb();
  const antesDe = new Date(Date.now() - (tenant.rescateHorasEspera ?? 3) * 60 * 60 * 1000);
  const cand = await reclamarToque1(db, tenant.id, antesDe);
  if (!cand) return false;

  try {
    if (await siguioOptOut(db, tenant.id, cand.clienteWa)) {
      await marcarOptOut(db, cand.id);
      return true;
    }
    if (await enModoHumano(db, tenant.id, cand.clienteWa)) {
      await revertirToque1(db, cand.id); // reintenta en un tick más adelante
      return true;
    }
    const info = await proximaFechaConHorarios(tenant, cand.servicioId);
    if (!info) {
      await revertirToque1(db, cand.id); // sin cupo por ahora; reintenta luego
      return true;
    }
    const mostrados = info.libres.slice(0, MAX_FILAS_LISTA);
    const cuerpo = construirTextoToque1(tenant, cand, mostrados.length);
    await enviarLista(
      tenant,
      cand.clienteWa,
      cuerpo,
      "Ver horarios",
      mostrados.map((h) => opcionHorario(info.fecha, h)),
    );
    console.log(`[rescate] toque1 → ${enmascararTelefono(cand.clienteWa)} (tenant ${tenant.id}, cotización ${cand.id})`);
  } catch (e) {
    console.error(`[rescate] error en toque1 (cotización ${cand.id}):`, e);
    await revertirToque1(db, cand.id);
  }
  return true;
}

/** Intenta procesar UN candidato al toque2 de un tenant. Devuelve false si no había ninguno. */
async function procesarToque2(tenant: Tenant): Promise<boolean> {
  const db = obtenerDb();
  if (!tenant.rescatePlantilla) return false; // sin plantilla configurada, no hay nada que mandar

  const antesDe = new Date(Date.now() - TOQUE2_HORAS_DESPUES * 60 * 60 * 1000);
  const cand = await reclamarToque2(db, tenant.id, antesDe);
  if (!cand) return false;

  try {
    if (await siguioOptOut(db, tenant.id, cand.clienteWa)) {
      await marcarOptOut(db, cand.id);
      return true;
    }
    if (await enModoHumano(db, tenant.id, cand.clienteWa)) {
      await revertirToque2(db, cand.id);
      return true;
    }
    const nombre = await nombreClienteAprox(db, tenant.id, cand.clienteWa);
    const servicio = nombreServicio(tenant, cand.servicioId);
    const monto = `${tenant.moneda}${cand.monto.toLocaleString("es-CR")}`;
    const variable = tenant.rescateToque2Texto || servicio;
    // Idioma por tenant (E8/BLOQ-06): un cliente puede aprobar sus plantillas en
    // "es_MX" y otro en "es" — no es fail-closed (no es un secreto), solo un
    // default en cascada: tenant → env global → "es".
    const idioma = tenant.plantillaIdioma ?? process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
    await enviarPlantilla(tenant, cand.clienteWa, tenant.rescatePlantilla, idioma, [nombre, variable, monto], "marketing");
    console.log(`[rescate] toque2 → ${enmascararTelefono(cand.clienteWa)} (tenant ${tenant.id}, cotización ${cand.id})`);
  } catch (e) {
    console.error(`[rescate] error en toque2 (cotización ${cand.id}):`, e);
    await revertirToque2(db, cand.id);
  }
  return true;
}

/**
 * Ejecuta `intentar` repetidamente (con `esperar(esperaMs)` entre cada llamada
 * exitosa) hasta que devuelva `false` o se llegue a `maxPorTick` — el tope que
 * reemplaza el `while` sin límite de antes (F8). Se recibe `intentar`/`esperar`
 * inyectados para poder probar el tope con un mock, sin DB ni WhatsApp real ni
 * temporizadores reales. Devuelve cuántas veces `intentar` devolvió `true`.
 */
export async function procesarConTope(
  intentar: () => Promise<boolean>,
  maxPorTick: number,
  esperar: (ms: number) => Promise<void>,
  esperaMs: number,
): Promise<number> {
  let procesados = 0;
  for (let i = 0; i < maxPorTick; i++) {
    if (!(await intentar())) break;
    procesados++;
    await esperar(esperaMs);
  }
  return procesados;
}

async function procesarTenant(tenant: Tenant): Promise<void> {
  // Tope por tick (F8): como mucho RESCATE_MAX_POR_TICK candidatos de cada
  // toque por vuelta, para que el `for` sobre listarTenants() SIEMPRE avance
  // al siguiente tenant en vez de quedarse drenando uno solo.
  await procesarConTope(() => procesarToque1(tenant), RESCATE_MAX_POR_TICK, dormir, INTERVALO_ENVIO_MS);
  await procesarConTope(() => procesarToque2(tenant), RESCATE_MAX_POR_TICK, dormir, INTERVALO_ENVIO_MS);
}

/** Arranca el worker de rescate. Llamar UNA vez al iniciar el servidor (solo si hay DB). */
export function iniciarRescate(): void {
  const loop = async () => {
    while (true) {
      try {
        // Serie, no mapConLimite (F8, punto 4): con el tope por tick de arriba,
        // el `for` ya avanza de tenant en tenant sin que uno drene al resto —
        // eso es lo que exige la fairness. Sumar concurrencia acá sería una
        // mejora de throughput (menos tiempo en dar la vuelta completa a 50
        // tenants), no de fairness, y no la pide ningún test de aceptación de
        // F8; se deja para cuando el volumen real lo justifique.
        for (const tenant of listarTenants()) {
          if (!tenant.rescateActivo || !tenantPuede(tenant, "rescateCotizaciones")) continue;
          await procesarTenant(tenant);
        }
      } catch (e) {
        console.error("[rescate] error en el loop:", e);
        capturarError(e, { loop: "rescate" });
      }
      await dormir(POLL_MS);
    }
  };

  // Loop de purga (ROADMAP F11), intervalo propio y espaciado, igual criterio
  // que src/queue/worker.ts: un fallo se loguea y va a Sentry, nunca tumba el loop.
  const loopPurga = async () => {
    while (true) {
      await dormir(PURGA_INTERVAL_MS);
      try {
        const n = await purgarCotizacionesFinalizadas(obtenerDb(), JOBS_RETENCION_DIAS);
        if (n > 0) console.log(`[rescate] purga: ${n} cotización(es) finalizada(s) borrada(s)`);
      } catch (e) {
        console.error("[rescate] purga error:", e);
        capturarError(e, { loop: "purga-rescate" });
      }
    }
  };

  loop().catch((e) => {
    console.error("[rescate] el loop murió inesperadamente:", e);
    capturarError(e, { loop: "rescate", fatal: true });
  });
  loopPurga().catch((e) => {
    console.error("[rescate] loop de purga terminó inesperadamente:", e);
    capturarError(e, { loop: "purga-rescate", fatal: true });
  });
  console.log(
    `Worker de rescate de cotizaciones iniciado (poll cada ${POLL_MS}ms · throttle ${INTERVALO_ENVIO_MS}ms entre envíos · tope ${RESCATE_MAX_POR_TICK}/tick por toque).`,
  );
}
