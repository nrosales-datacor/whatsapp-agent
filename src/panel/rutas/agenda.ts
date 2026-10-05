import type { Cita } from "../../types";
import { tenantPuede } from "../../billing/planes";
import { empleadoOcupado, espaciosPorEmpleado } from "../../booking/availability";
import { esChoqueDeEmpleado } from "../../booking/errores";
import {
  hoyEnTz,
  sincronizarCancelacionGcal,
  sincronizarCreacionGcal,
  sincronizarReprogramacionGcal,
} from "../../booking/gestionCitas";
import { json, leerBody } from "../http";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Agenda (C2.1): citas, disponibilidad y acciones sobre una cita.
// ─────────────────────────────────────────────────────────────────────────────

/** citas y citas/:id/:accion. */
export async function manejarRutasAgenda(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, repo, ruta, metodo, tenant } = ctx;
  // ── Agenda (C2.1) ──
  const fechaValida = (f: string) => /^\d{4}-\d{2}-\d{2}$/.test(f);
  const horaValida = (h: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h);

  if (ruta === "citas" && metodo === "GET") {
    const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
    const desde = q.get("desde") ?? "";
    const hasta = q.get("hasta") ?? "";
    if (!fechaValida(desde) || !fechaValida(hasta)) {
      return json(res, 400, { ok: false, error: "desde/hasta inválidos (usar YYYY-MM-DD)" }), true;
    }
    const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
    const citas = (await repo.citasEnRango(tenant.id, desde, hasta)).map((c) => ({
      ...c,
      servicioNombre: nombreDe(c.servicioId),
    }));
    return json(res, 200, { ok: true, citas }), true;
  }

  if (ruta === "citas/disponibilidad" && metodo === "GET") {
    const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
    const fecha = q.get("fecha") ?? "";
    const servicioId = q.get("servicioId") ?? "";
    if (!fechaValida(fecha)) return json(res, 400, { ok: false, error: "fecha inválida" }), true;
    const servicio = tenant.servicios.find((s) => s.id === servicioId && s.agendable);
    if (!servicio) return json(res, 400, { ok: false, error: "Servicio inválido" }), true;
    const citasDia = await repo.citasPorFecha(tenant.id, fecha);
    // `espacios` trae, por cada hora, QUIÉNES la tienen libre (ALTO-07). `libres` se
    // mantiene por compatibilidad: con equipo cargado es la unión de todo el equipo.
    const espacios = espaciosPorEmpleado(tenant, fecha, servicioId, citasDia);
    const libres = espacios.map((e) => e.hora);
    const ocupadas = citasDia
      .filter((c) => c.estado === "agendada")
      .map((c) => ({ hora: c.hora, citaId: c.id, clienteNombre: c.clienteNombre, empleadoId: c.empleadoId }));
    return json(res, 200, { ok: true, libres, espacios, ocupadas }), true;
  }

  if (ruta === "citas" && metodo === "POST") {
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const clienteNombre = String(body.clienteNombre ?? "").trim();
    const clienteWa = String(body.clienteWa ?? "").trim();
    const servicioId = String(body.servicioId ?? "");
    const fecha = String(body.fecha ?? "");
    const hora = String(body.hora ?? "");
    const placa = body.placa ? String(body.placa).trim() : undefined;
    const precio =
      body.precio != null && !Number.isNaN(Number(body.precio)) ? Number(body.precio) : undefined;

    if (!clienteNombre || clienteNombre.length > 200) {
      return json(res, 400, { ok: false, error: "Nombre del cliente inválido" }), true;
    }
    if (!clienteWa || clienteWa.length > 40) {
      return json(res, 400, { ok: false, error: "Teléfono del cliente inválido" }), true;
    }
    const servicio = tenant.servicios.find((s) => s.id === servicioId && s.agendable);
    if (!servicio) return json(res, 400, { ok: false, error: "Servicio inválido" }), true;
    if (!fechaValida(fecha) || !horaValida(hora)) {
      return json(res, 400, { ok: false, error: "Formato de fecha/hora inválido" }), true;
    }
    if (fecha < hoyEnTz(tenant.timezone)) {
      return json(res, 400, { ok: false, error: "No se puede agendar una fecha pasada" }), true;
    }

    // Quién atiende (ALTO-07). Opcional: dejarlo vacío registra la cita sin asignar,
    // que es lo correcto para un negocio sin equipo cargado o para un walk-in que el
    // dueño todavía no repartió.
    const empleadoId = String(body.empleadoId ?? "").trim() || undefined;
    if (empleadoId) {
      const emp = (tenant.empleados ?? []).find((e) => e.id === empleadoId);
      if (!emp) return json(res, 400, { ok: false, error: "Esa persona no existe en el negocio" }), true;
      // A diferencia del choque de horario del negocio (que el panel permite a propósito
      // para walk-ins), duplicarle el horario a UNA persona no se permite nunca.
      const citasDia = await repo.citasPorFecha(tenant.id, fecha);
      if (empleadoOcupado(tenant, empleadoId, fecha, hora, servicioId, citasDia)) {
        return json(res, 409, { ok: false, error: `${emp.nombre} ya tiene una cita a esa hora` }), true;
      }
    }

    let cita: Cita;
    try {
      cita = await repo.crearCita(
        { tenantId: tenant.id, clienteWa, clienteNombre, servicioId, empleadoId, fecha, hora, placa, precio, origen: "manual" },
        // Re-chequeo ATÓMICO (E7): bajo el lock de la fecha, que esa persona siga libre.
        // Sin persona asignada no se verifica nada (walk-ins encimados, a propósito).
        empleadoId ? (citas) => !empleadoOcupado(tenant, empleadoId, fecha, hora, servicioId, citas) : undefined,
      );
    } catch (e) {
      if (esChoqueDeEmpleado(e)) {
        return json(res, 409, { ok: false, error: "Esa persona ya tiene una cita a esa hora" }), true;
      }
      throw e;
    }
    await sincronizarCreacionGcal(tenant, repo, cita);
    // Rescate de cotizaciones (Carril D, 1.1): una cita creada a mano en la Agenda
    // también cierra una cotización activa del cliente para ese servicio.
    if (tenantPuede(tenant, "rescateCotizaciones")) {
      await repo
        .actualizarCotizacionPorCita(tenant.id, clienteWa, servicioId, cita.id, precio)
        .catch((e) => console.error("[rescate] actualizarCotizacionPorCita:", e));
    }
    return json(res, 200, { ok: true, cita }), true;
  }

  // /citas/{id}/{accion}
  const partesCita = ruta.split("/");
  if (partesCita[0] === "citas" && partesCita[1]) {
    const citaId = decodeURIComponent(partesCita[1]);
    const accion = partesCita[2];

    if (accion === "confirmar" && metodo === "POST") {
      const cita = await repo.confirmarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "completar" && metodo === "POST") {
      const cita = await repo.completarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "cancelar" && metodo === "POST") {
      const cita = await repo.cancelarCita(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      await sincronizarCancelacionGcal(tenant, cita);
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "no-show" && metodo === "POST") {
      const cita = await repo.marcarNoShow(tenant.id, citaId);
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }

    if (accion === "reprogramar" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const fecha = String(body.fecha ?? "");
      const hora = String(body.hora ?? "");
      if (!fechaValida(fecha) || !horaValida(hora)) {
        return json(res, 400, { ok: false, error: "Formato de fecha/hora inválido" }), true;
      }
      if (fecha < hoyEnTz(tenant.timezone)) {
        return json(res, 400, { ok: false, error: "No se puede reprogramar a una fecha pasada" }), true;
      }
      // La cita se mueve CON su persona (ALTO-07): si a esa persona el nuevo horario le
      // choca con otra cita suya, se rechaza. El choque a nivel de NEGOCIO se sigue
      // permitiendo, igual que en el alta manual.
      const laCita = await repo.obtenerCitaPorId(tenant.id, citaId);
      if (!laCita) return json(res, 404, { ok: false, error: "No existe" }), true;
      if (laCita.empleadoId) {
        const citasDia = await repo.citasPorFecha(tenant.id, fecha);
        const emp = (tenant.empleados ?? []).find((e) => e.id === laCita.empleadoId);
        if (empleadoOcupado(tenant, laCita.empleadoId, fecha, hora, laCita.servicioId, citasDia, citaId)) {
          return json(res, 409, { ok: false, error: `${emp?.nombre ?? "Esa persona"} ya tiene una cita a esa hora` }), true;
        }
      }
      let cita: Cita | null;
      try {
        const empleadoDeLaCita = laCita.empleadoId;
        cita = await repo.reprogramarCita(
          tenant.id,
          citaId,
          fecha,
          hora,
          // Re-chequeo ATÓMICO (E7) de la persona de la cita; las citas ya vienen sin la propia.
          empleadoDeLaCita
            ? (citas) => !empleadoOcupado(tenant, empleadoDeLaCita, fecha, hora, laCita.servicioId, citas, citaId)
            : undefined,
        );
      } catch (e) {
        if (esChoqueDeEmpleado(e)) {
          return json(res, 409, { ok: false, error: "Esa persona ya tiene una cita a esa hora" }), true;
        }
        throw e;
      }
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      await sincronizarReprogramacionGcal(tenant, cita);
      return json(res, 200, { ok: true, cita }), true;
    }

    // Reasignar a otra persona (ALTO-07), desde el detalle de la cita en la Agenda.
    // `empleadoId` vacío la deja sin asignar.
    if (accion === "asignar" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const nuevo = String(body.empleadoId ?? "").trim();
      if (nuevo && !(tenant.empleados ?? []).some((e) => e.id === nuevo)) {
        return json(res, 400, { ok: false, error: "Esa persona no existe en el negocio" }), true;
      }
      const actual = await repo.obtenerCitaPorId(tenant.id, citaId);
      if (!actual) return json(res, 404, { ok: false, error: "No existe" }), true;
      if (nuevo) {
        const citasDia = await repo.citasPorFecha(tenant.id, actual.fecha);
        if (empleadoOcupado(tenant, nuevo, actual.fecha, actual.hora, actual.servicioId, citasDia, citaId)) {
          const emp = (tenant.empleados ?? []).find((e) => e.id === nuevo);
          return json(res, 409, { ok: false, error: `${emp?.nombre ?? "Esa persona"} ya tiene una cita a esa hora` }), true;
        }
      }
      let cita: Cita | null;
      try {
        cita = await repo.reasignarCita(tenant.id, citaId, nuevo || null);
      } catch (e) {
        if (esChoqueDeEmpleado(e)) {
          return json(res, 409, { ok: false, error: "Esa persona ya tiene una cita a esa hora" }), true;
        }
        throw e;
      }
      if (!cita) return json(res, 404, { ok: false, error: "No existe" }), true;
      return json(res, 200, { ok: true, cita }), true;
    }
  }
  return false;
}
