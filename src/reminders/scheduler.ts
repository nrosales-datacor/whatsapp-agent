import type { Cita, Repositorio, Tenant, TipoRecordatorio } from "../types";
import { listarTenants } from "../config/tenantStore";
import { botonesPostServicio, botonesPostServicioPro, botonesRecordatorio, enviarBotones, enviarPlantilla } from "../whatsapp/client";
import { tenantPuede } from "../billing/planes";
import { capturarError } from "../observabilidad/sentry";

// ─────────────────────────────────────────────────────────────────────────────
// RECORDATORIOS DE CITA por WhatsApp.
//
// Cada X minutos (RECORDATORIOS_INTERVALO_MIN, default 5) se revisan las citas
// de HOY y MAÑANA de cada tenant y se envían dos recordatorios por cita:
//   • DÍA ANTES: a partir de las RECORDATORIO_DIA_ANTES_HORA (default 17:00)
//     del día anterior a la cita.
//   • MISMO DÍA: RECORDATORIO_HORAS_ANTES horas antes de la cita (default 2),
//     nunca antes de las 6:00 am.
// Cada envío se marca en la cita (recordatorio_*_en) para no duplicar.
//
// Además, se revisan las citas de HOY y AYER para el SEGUIMIENTO POST-SERVICIO
// (C3.1, anti reseña negativa): POST_SERVICIO_HORAS_DESPUES horas después de la
// hora de la cita (default 3), se pregunta si todo salió bien. "Bien" pide la
// reseña de Google (si el negocio configuró el link en "Mi negocio"); "mal"
// escala a un humano ANTES de que el cliente deje una reseña negativa.
//
// ⚠️ VENTANA DE 24 H DE META: WhatsApp solo permite texto libre dentro de las
// 24 h posteriores al último mensaje DEL CLIENTE. Como el recordatorio del día
// antes casi siempre cae fuera de esa ventana, lo correcto es usar una PLANTILLA
// aprobada en el WhatsApp Manager:
//   WHATSAPP_TEMPLATE_RECORDATORIO=nombre_de_la_plantilla  (con 3 variables:
//     {{1}} nombre del cliente · {{2}} servicio · {{3}} "mañana/hoy a las HH:mm")
//   WHATSAPP_TEMPLATE_IDIOMA=es  (o es_MX, etc. — el idioma con que se aprobó)
// Si NO se configura plantilla, se intenta texto libre (funciona con el número
// de prueba de Meta y dentro de la ventana de 24 h; fuera de ella, Meta lo
// rechaza y se reintenta en el siguiente ciclo).
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALO_MIN = Number(process.env.RECORDATORIOS_INTERVALO_MIN ?? 5);
const DIA_ANTES_HORA = process.env.RECORDATORIO_DIA_ANTES_HORA ?? "17:00";
const HORAS_ANTES = Number(process.env.RECORDATORIO_HORAS_ANTES ?? 2);
const NO_ANTES_DE_MIN = 6 * 60; // nunca despertar al cliente antes de las 6:00 am
const POST_SERVICIO_HORAS_DESPUES = Number(process.env.POST_SERVICIO_HORAS_DESPUES ?? 3);

function aMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Fecha ("YYYY-MM-DD") y minutos desde medianoche AHORA, en la zona del tenant. */
function ahoraEnTz(timezone: string): { fecha: string; minutos: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hora = Number(get("hour")) % 24; // "24:xx" → 0:xx (peculiaridad de hour12:false)
  return { fecha: `${get("year")}-${get("month")}-${get("day")}`, minutos: hora * 60 + Number(get("minute")) };
}

/** Suma días a una fecha "YYYY-MM-DD" (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaMasDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** "2026-06-12" → "jueves 12 de junio" (en la zona del tenant). */
function fechaBonita(fecha: string, timezone: string): string {
  return new Date(`${fecha}T12:00:00`).toLocaleDateString("es-CR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: timezone,
  });
}

/** Envía el recordatorio (plantilla si está configurada; si no, texto libre). */
async function enviarRecordatorio(tenant: Tenant, cita: Cita, tipo: TipoRecordatorio): Promise<void> {
  const servicio = tenant.servicios.find((s) => s.id === cita.servicioId);
  const nombreServicio = servicio?.nombre ?? cita.servicioId;
  const cuando =
    tipo === "dia_antes"
      ? `mañana ${fechaBonita(cita.fecha, tenant.timezone)} a las ${cita.hora}`
      : `hoy a las ${cita.hora}`;

  const plantilla = process.env.WHATSAPP_TEMPLATE_RECORDATORIO;
  if (plantilla) {
    // Plantilla aprobada (para fuera de la ventana de 24 h). NOTA: para que traiga
    // botones "Confirmo/Reprogramar", la plantilla debe declararse en el WhatsApp
    // Manager con componentes de tipo quick-reply y sus payloads; eso queda pendiente
    // de la aprobación de la plantilla. Mientras tanto, el texto libre (abajo) sí los
    // lleva (funciona con el número de prueba y dentro de la ventana de 24 h).
    const idioma = process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
    await enviarPlantilla(
      tenant,
      cita.clienteWa,
      plantilla,
      idioma,
      [cita.clienteNombre, nombreServicio, cuando],
      "utilidad",
    );
    return;
  }

  // Texto libre CON BOTONES interactivos (C1.3, anti no-show): el cliente confirma
  // con un toque o pide reprogramar. La respuesta llega como mensaje `interactive`
  // y la maneja handleWebhook (confirmar = acción directa; reprogramar = va al agente).
  const cuerpo =
    `¡Hola ${cita.clienteNombre}! 👋 Te recordamos tu cita en ${tenant.nombre} ` +
    `${cuando}: ${nombreServicio}. ¿Nos confirmás?`;
  await enviarBotones(tenant, cita.clienteWa, cuerpo, botonesRecordatorio(cita.id));
}

/**
 * Envía el seguimiento post-servicio (C3.1): pregunta si todo salió bien. La
 * respuesta la maneja handleWebhook como acción directa (respuestaPostServicio),
 * igual que la confirmación del recordatorio (C1.3). Mismo caveat de la ventana de
 * 24 h que enviarRecordatorio: sin plantilla aprobada, el texto libre con botones
 * solo llega si el cliente escribió en las últimas 24 h (o con el número de prueba).
 *
 * Plan Pro (Carril D, 1.3 — motor de reseñas completo): 3 botones en vez de 2, y se
 * registra el envío en wa_seguimientos (repo.crearSeguimiento) para el contador del
 * dashboard. Plan Básico: flujo legacy sin tracking (igual que siempre).
 */
async function enviarPostServicio(tenant: Tenant, cita: Cita, repo: Repositorio): Promise<void> {
  const servicio = tenant.servicios.find((s) => s.id === cita.servicioId);
  const nombreServicio = servicio?.nombre ?? cita.servicioId;
  const cuerpo = `¡Hola ${cita.clienteNombre}! 👋 ¿Cómo te fue con tu ${nombreServicio} en ${tenant.nombre}? 🚗`;
  const esPro = tenantPuede(tenant, "resenasPro");
  await enviarBotones(tenant, cita.clienteWa, cuerpo, esPro ? botonesPostServicioPro(cita.id) : botonesPostServicio(cita.id));
  if (esPro) await repo.crearSeguimiento(tenant.id, cita.id);
}

/** Revisa las citas de un tenant y envía los recordatorios que tocan. */
async function procesarTenant(tenant: Tenant, repo: Repositorio): Promise<void> {
  const { fecha: hoy, minutos: ahoraMin } = ahoraEnTz(tenant.timezone);
  const manana = fechaMasDias(hoy, 1);
  const ayer = fechaMasDias(hoy, -1);
  const haceUnaHora = Date.now() - 60 * 60 * 1000;

  // ── DÍA ANTES: citas de mañana, a partir de DIA_ANTES_HORA de hoy ──────────
  if (ahoraMin >= aMin(DIA_ANTES_HORA)) {
    for (const cita of await repo.citasPorFecha(tenant.id, manana)) {
      if (cita.estado !== "agendada" || cita.recordatorioDiaAntesEn) continue;
      // Si la cita se creó hace muy poco, el cliente acaba de recibir la
      // confirmación: no tiene sentido recordarle de inmediato.
      if (new Date(cita.creadaEn).getTime() > haceUnaHora) continue;
      // Claim atómico: solo UNA instancia pasa de NULL a timestamp; las demás
      // obtienen false y hacen continue → sin duplicados con N instancias.
      if (!(await repo.reclamarRecordatorio(cita.id, "dia_antes"))) continue;
      try {
        await enviarRecordatorio(tenant, cita, "dia_antes");
        console.log(`[recordatorios] día antes → cita ${cita.id} (${cita.clienteWa})`);
      } catch (e) {
        // El envío falló: revertir el claim para que el próximo tick reintente.
        await repo.revertirRecordatorio(cita.id, "dia_antes");
        console.error(`[recordatorios] error (día antes, cita ${cita.id}):`, e);
      }
    }
  }

  // ── MISMO DÍA: citas de hoy, HORAS_ANTES horas antes (nunca antes de 6 am) ─
  for (const cita of await repo.citasPorFecha(tenant.id, hoy)) {
    if (cita.estado !== "agendada" || cita.recordatorioMismoDiaEn) continue;
    const citaMin = aMin(cita.hora);
    if (ahoraMin >= citaMin) continue; // la hora ya pasó: no recordar tarde
    if (ahoraMin < Math.max(citaMin - HORAS_ANTES * 60, NO_ANTES_DE_MIN)) continue; // aún no toca
    if (new Date(cita.creadaEn).getTime() > haceUnaHora) continue; // recién agendada
    if (!(await repo.reclamarRecordatorio(cita.id, "mismo_dia"))) continue;
    try {
      await enviarRecordatorio(tenant, cita, "mismo_dia");
      console.log(`[recordatorios] mismo día → cita ${cita.id} (${cita.clienteWa})`);
    } catch (e) {
      await repo.revertirRecordatorio(cita.id, "mismo_dia");
      console.error(`[recordatorios] error (mismo día, cita ${cita.id}):`, e);
    }
  }

  // ── POST-SERVICIO (C3.1): citas de HOY y AYER, POST_SERVICIO_HORAS_DESPUES horas
  // después de la hora de la cita. Se manda tanto para "agendada" (el dueño no
  // siempre entra al panel a marcar "completada": se asume completada al pasar la
  // hora) como para "completada"; se excluyen "cancelada" y "no_show".
  for (const [fechaCita, diasAtras] of [[ayer, 1], [hoy, 0]] as const) {
    for (const cita of await repo.citasPorFecha(tenant.id, fechaCita)) {
      if (cita.estado !== "agendada" && cita.estado !== "completada") continue;
      if (cita.postServicioEn) continue;
      const minutosTranscurridos = diasAtras * 24 * 60 + ahoraMin - aMin(cita.hora);
      if (minutosTranscurridos < POST_SERVICIO_HORAS_DESPUES * 60) continue;
      if (!(await repo.reclamarRecordatorio(cita.id, "post_servicio"))) continue;
      try {
        await enviarPostServicio(tenant, cita, repo);
        console.log(`[recordatorios] post-servicio → cita ${cita.id} (${cita.clienteWa})`);
      } catch (e) {
        await repo.revertirRecordatorio(cita.id, "post_servicio");
        console.error(`[recordatorios] error (post-servicio, cita ${cita.id}):`, e);
      }
    }
  }
}

/**
 * Arranca el ciclo de recordatorios. Llamar UNA vez al iniciar el servidor.
 * Corre un primer chequeo de inmediato y luego cada INTERVALO_MIN minutos.
 */
export function iniciarRecordatorios(repo: Repositorio): void {
  const tick = async () => {
    for (const tenant of listarTenants()) {
      try {
        await procesarTenant(tenant, repo);
      } catch (e) {
        console.error(`[recordatorios] error procesando tenant ${tenant.id}:`, e);
        capturarError(e, { loop: "recordatorios", tenantId: tenant.id });
      }
    }
  };
  tick().catch((e) => {
    console.error("[recordatorios] primer chequeo:", e);
    capturarError(e, { loop: "recordatorios", momento: "primer-chequeo" });
  });
  setInterval(
    () =>
      tick().catch((e) => {
        console.error("[recordatorios] tick:", e);
        capturarError(e, { loop: "recordatorios", momento: "tick" });
      }),
    INTERVALO_MIN * 60 * 1000,
  );
  console.log(
    `Recordatorios activos: día antes a partir de las ${DIA_ANTES_HORA} · mismo día ${HORAS_ANTES} h antes · chequeo cada ${INTERVALO_MIN} min.`,
  );
}
