import type { Cita, Repositorio, Tenant, TipoRecordatorio } from "../types";
import { TENANTS } from "../config/tenants";
import { enviarPlantilla, enviarTexto } from "../whatsapp/client";

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
    const idioma = process.env.WHATSAPP_TEMPLATE_IDIOMA ?? "es";
    await enviarPlantilla(tenant, cita.clienteWa, plantilla, idioma, [
      cita.clienteNombre,
      nombreServicio,
      cuando,
    ]);
    return;
  }

  const texto =
    `¡Hola ${cita.clienteNombre}! 👋 Te recordamos tu cita en ${tenant.nombre} ` +
    `${cuando}: ${nombreServicio}. ` +
    `Si necesitás reprogramar, escribinos por acá. ¡Te esperamos! 🚗`;
  await enviarTexto(tenant, cita.clienteWa, texto);
}

/** Revisa las citas de un tenant y envía los recordatorios que tocan. */
async function procesarTenant(tenant: Tenant, repo: Repositorio): Promise<void> {
  const { fecha: hoy, minutos: ahoraMin } = ahoraEnTz(tenant.timezone);
  const manana = fechaMasDias(hoy, 1);
  const haceUnaHora = Date.now() - 60 * 60 * 1000;

  // ── DÍA ANTES: citas de mañana, a partir de DIA_ANTES_HORA de hoy ──────────
  if (ahoraMin >= aMin(DIA_ANTES_HORA)) {
    for (const cita of await repo.citasPorFecha(tenant.id, manana)) {
      if (cita.estado !== "agendada" || cita.recordatorioDiaAntesEn) continue;
      // Si la cita se creó hace muy poco, el cliente acaba de recibir la
      // confirmación: no tiene sentido recordarle de inmediato.
      if (new Date(cita.creadaEn).getTime() > haceUnaHora) continue;
      try {
        await enviarRecordatorio(tenant, cita, "dia_antes");
        await repo.marcarRecordatorio(cita.id, "dia_antes");
        console.log(`[recordatorios] día antes → cita ${cita.id} (${cita.clienteWa})`);
      } catch (e) {
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
    try {
      await enviarRecordatorio(tenant, cita, "mismo_dia");
      await repo.marcarRecordatorio(cita.id, "mismo_dia");
      console.log(`[recordatorios] mismo día → cita ${cita.id} (${cita.clienteWa})`);
    } catch (e) {
      console.error(`[recordatorios] error (mismo día, cita ${cita.id}):`, e);
    }
  }
}

/**
 * Arranca el ciclo de recordatorios. Llamar UNA vez al iniciar el servidor.
 * Corre un primer chequeo de inmediato y luego cada INTERVALO_MIN minutos.
 */
export function iniciarRecordatorios(repo: Repositorio): void {
  const tick = async () => {
    for (const tenant of TENANTS) {
      try {
        await procesarTenant(tenant, repo);
      } catch (e) {
        console.error(`[recordatorios] error procesando tenant ${tenant.id}:`, e);
      }
    }
  };
  tick().catch((e) => console.error("[recordatorios] primer chequeo:", e));
  setInterval(() => tick().catch((e) => console.error("[recordatorios] tick:", e)), INTERVALO_MIN * 60 * 1000);
  console.log(
    `Recordatorios activos: día antes a partir de las ${DIA_ANTES_HORA} · mismo día ${HORAS_ANTES} h antes · chequeo cada ${INTERVALO_MIN} min.`,
  );
}
