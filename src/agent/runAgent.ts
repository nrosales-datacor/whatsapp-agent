import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Cita, MensajeConversacion, MensajeInteractivo, Repositorio, Service, Tenant } from "../types";
import { construirSystemPrompt } from "./systemPrompt";
import { TOOLS } from "./tools";
import { opcionEmpleado, opcionHorario } from "../whatsapp/client";
import { empleadosElegibles, espaciosDisponibles, espaciosPorEmpleado } from "../booking/availability";
import { esChoqueDeEmpleado } from "../booking/errores";
import {
  hoyEnTz,
  sincronizarCancelacionGcal,
  sincronizarCreacionGcal,
  sincronizarReprogramacionGcal,
} from "../booking/gestionCitas";
import { registrarLatenciaAgente } from "../observabilidad/metricas";
import { registrarUsoLlm } from "../observabilidad/uso";
import { calcularCostoMillonesimos } from "../observabilidad/costoLlm";
import { tenantPuede } from "../billing/planes";
import { OPENAI_MAX_REINTENTOS, TIMEOUT_OPENAI_MS } from "../red/timeouts";

const MODELO = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_PASOS = 4; // tope de iteraciones de tool-calling por mensaje

// Inicialización perezosa: el server arranca aunque todavía no haya OPENAI_API_KEY;
// solo se necesita cuando llega un mensaje real.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  // timeout/maxRetries explícitos: los defaults del SDK (600 s × 3 intentos) dejan
  // el worker serial colgado hasta 30 min y con él la cola de TODOS los tenants
  // (ver src/red/timeouts.ts). Si se agota, la cola durable reintenta el job.
  if (!_openai) {
    _openai = new OpenAI({ timeout: TIMEOUT_OPENAI_MS, maxRetries: OPENAI_MAX_REINTENTOS });
  }
  return _openai;
}

interface ContextoAgente {
  tenant: Tenant;
  repo: Repositorio;
  clienteWa: string;
}

/** Máximo de filas que admite una lista de WhatsApp (límite duro de Meta). */
const MAX_FILAS_LISTA = 10;

/**
 * Precio que se guarda en la cita (revisión pre-venta 2026-10, ALTO-09). Antes se
 * persistía `args.precio` tal cual lo mandaba el modelo: "el precio acordado es
 * 1000" (prompt injection) o un error de escala (15 en vez de 15000) entraba a
 * ingresos, CRM y rescate. Si el servicio tiene precio FIJO en el catálogo, manda
 * el catálogo; el del modelo solo se acepta para servicios de precio variable
 * (cotizados), y solo si es un número positivo.
 */
export function precioDeCita(servicio: Service | undefined, precioModelo: unknown): number | undefined {
  if (servicio && servicio.precio != null && !servicio.precioVariable) return servicio.precio;
  if (precioModelo == null) return undefined;
  const n = Number(precioModelo);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Ejecuta una herramienta pedida por el modelo y devuelve el resultado (string JSON).
 * `capturas` es un canal de salida lateral: algunas herramientas (p. ej.
 * `ofrecer_horarios`) no solo informan al modelo, sino que dejan un efecto para
 * handleWebhook (mandar un mensaje interactivo). Se rellena, no se devuelve al modelo.
 *
 * Exportada SOLO para los tests (auditoría ALTO-18: no había ninguna prueba del corazón
 * del producto). Invocarla directo con args hostiles verifica los guards sin gastar una
 * llamada al LLM y sin depender de que el modelo se porte bien.
 */
export async function ejecutarTool(
  nombre: string,
  args: Record<string, unknown>,
  ctx: ContextoAgente,
  capturas: { interactivo?: MensajeInteractivo },
): Promise<string> {
  const { tenant, repo, clienteWa } = ctx;

  // Candado: solo se agendan servicios marcados como agendables.
  const servicioEsAgendable = (servicioId: string) =>
    tenant.servicios.some((s) => s.id === servicioId && s.agendable);

  // Equipo que atiende (ALTO-07). Vacío = el negocio corre como un solo recurso y toda
  // la rama de "con quién" queda apagada sola, sin ramas nuevas en el flujo.
  const hayEquipo = (tenant.empleados ?? []).length > 0;
  const nombreEmpleado = (id: string | undefined) =>
    (id && tenant.empleados?.find((e) => e.id === id)?.nombre) || undefined;
  /** Normaliza el empleadoId que mandó el modelo: string vacío / "cualquiera" = sin preferencia. */
  const empleadoPedido = (v: unknown): string | undefined => {
    const s = String(v ?? "").trim();
    if (!s || s.toLowerCase() === "cualquiera") return undefined;
    return s;
  };

  if (nombre === "ofrecer_empleados") {
    const servicioId = String(args.servicioId);
    if (!servicioEsAgendable(servicioId)) {
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda (no requiere cita). Solo se agendan los servicios marcados como agendables.",
      });
    }
    if (!hayEquipo) {
      return JSON.stringify({
        ok: false,
        motivo: "este negocio no tiene equipo cargado: no hay con quién elegir. Pasá directo a ofrecer_horarios.",
      });
    }
    // Se mira "hoy" solo para no listar a quien está de vacaciones justo ahora. La
    // disponibilidad real por fecha la resuelve después ofrecer_horarios.
    const elegibles = empleadosElegibles(tenant, hoyEnTz(tenant.timezone), servicioId);
    if (elegibles.length === 0) {
      return JSON.stringify({ ok: false, motivo: "no hay nadie disponible para ese servicio; ofrecé otro servicio o escalá." });
    }
    if (elegibles.length === 1) {
      return JSON.stringify({
        ok: false,
        motivo: `solo atiende ${elegibles[0].nombre}, no hay nada que elegir. Pasá directo a ofrecer_horarios.`,
        empleadoId: elegibles[0].id,
      });
    }
    const mostrados = elegibles.slice(0, MAX_FILAS_LISTA - 1); // deja lugar a "Cualquiera"
    capturas.interactivo = {
      tipo: "lista",
      cuerpo: "", // handleWebhook lo rellena con la frase que redacte el agente.
      textoBoton: "Ver equipo",
      opciones: [
        ...mostrados.map((e) => opcionEmpleado(servicioId, e.id, e.nombre)),
        opcionEmpleado(servicioId, "", "Cualquiera"),
      ],
    };
    return JSON.stringify({
      ok: true,
      empleados: mostrados.map((e) => ({ id: e.id, nombre: e.nombre })),
      mensaje:
        "Le mostré al cliente la lista tocable de con quién atenderse (más la opción 'Cualquiera'). Preguntale con UNA frase corta con quién prefiere. No repitas los nombres en texto.",
    });
  }

  if (nombre === "ofrecer_horarios") {
    const fecha = String(args.fecha);
    const servicioId = String(args.servicioId);
    const franja = args.franja ? String(args.franja) : "todos";
    const empleadoId = empleadoPedido(args.empleadoId);
    if (!servicioEsAgendable(servicioId)) {
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda (no requiere cita). Solo se agendan los servicios marcados como agendables.",
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return JSON.stringify({ ok: false, motivo: "formato de fecha inválido: usá YYYY-MM-DD." });
    }
    if (empleadoId && !nombreEmpleado(empleadoId)) {
      return JSON.stringify({ ok: false, motivo: `no existe nadie con el id "${empleadoId}" en este negocio.` });
    }
    const citas = await repo.citasPorFecha(tenant.id, fecha);
    let espacios = espaciosPorEmpleado(tenant, fecha, servicioId, citas);
    // Si el cliente eligió persona, solo sus horarios; si no, la unión del equipo.
    if (empleadoId) espacios = espacios.filter((e) => e.empleados.includes(empleadoId));
    if (franja === "mañana") espacios = espacios.filter((e) => Number(e.hora.slice(0, 2)) < 12);
    else if (franja === "tarde") espacios = espacios.filter((e) => Number(e.hora.slice(0, 2)) >= 12);
    if (espacios.length === 0) {
      return JSON.stringify({
        ok: false,
        motivo: empleadoId
          ? `no hay horarios de ${nombreEmpleado(empleadoId)} para esa fecha/franja; ofrecé otra fecha, otra franja, u otra persona.`
          : "no hay horarios disponibles para esa fecha/franja; ofrecé otra fecha o franja.",
        disponibles: [],
      });
    }
    const mostrados = espacios.slice(0, MAX_FILAS_LISTA);
    const truncado = espacios.length > MAX_FILAS_LISTA;
    capturas.interactivo = {
      tipo: "lista",
      cuerpo: "", // handleWebhook lo rellena con la frase que redacte el agente.
      textoBoton: "Ver horarios",
      opciones: mostrados.map((e) => {
        // Con persona elegida el id la fija; sin elegir, se preasigna el primer libre de
        // cada horario para que el tap ya traiga a alguien y no haya un turno extra.
        const asignado = empleadoId ?? e.empleados[0];
        return opcionHorario(fecha, e.hora, asignado, hayEquipo ? nombreEmpleado(asignado) : undefined);
      }),
    };
    return JSON.stringify({
      ok: true,
      mostrados: mostrados.length,
      total: espacios.length,
      truncado,
      con: empleadoId ? nombreEmpleado(empleadoId) : undefined,
      mensaje: truncado
        ? "Le mostré al cliente los primeros horarios como lista tocable. Invitalo con UNA frase corta a elegir uno, y aclarale que si prefiere otra hora te la escriba. No repitas los horarios en texto."
        : "Le mostré al cliente los horarios como lista tocable. Invitalo con UNA frase corta a elegir uno. No repitas los horarios en texto.",
    });
  }

  if (nombre === "consultar_disponibilidad") {
    const fecha = String(args.fecha);
    const servicioId = String(args.servicioId);
    if (!servicioEsAgendable(servicioId)) {
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda (no requiere cita). Solo se agendan los servicios marcados como agendables.",
      });
    }
    const citas = await repo.citasPorFecha(tenant.id, fecha);
    const libres = espaciosDisponibles(tenant, fecha, servicioId, citas);
    return JSON.stringify({
      fecha,
      servicioId,
      disponibles: libres,
      mensaje: libres.length ? "Hay espacios disponibles." : "No hay espacios ese día.",
    });
  }

  if (nombre === "agendar_cita") {
    const servicioId = String(args.servicioId);
    const fecha = String(args.fecha);
    const hora = String(args.hora);
    if (!servicioEsAgendable(servicioId)) {
      // Sin texto de rubro: el motivo lo lee el modelo y puede parafrasearlo al cliente,
      // así que "los lavados son por orden de llegada" no puede vivir en un motor
      // multi-mercado (auditoría BLOQ-07). Mismo texto que las otras dos tools.
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda (no requiere cita). Solo se agendan los servicios marcados como agendables.",
      });
    }
    // Validar el formato de fecha/hora ANTES de persistir: la cita se muestra en el
    // panel, así que un valor con formato raro no debe colarse (defensa en profundidad
    // contra inyección por la ficha del cliente).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return JSON.stringify({ ok: false, motivo: "formato inválido: usá fecha YYYY-MM-DD y hora HH:mm (24h)." });
    }
    // No agendar en el pasado (auditoría BLOQ-08). `reprogramar_cita` ya lo validaba y
    // el panel también; el camino del bot —el que usa el cliente final— no. El único
    // freno era una instrucción del prompt, o sea una sugerencia a un modelo: en la
    // verificación empírica el modelo rechazó una fecha absurda pero SÍ aceptó una hora
    // ya transcurrida de hoy, porque confía en lo que le devolvió `ofrecer_horarios`.
    if (fecha < hoyEnTz(tenant.timezone)) {
      return JSON.stringify({ ok: false, motivo: "no se puede agendar en una fecha pasada." });
    }
    // Validar que el espacio siga libre antes de crear (evita doble reserva). Con el
    // arreglo de BLOQ-09, esta lista además ya no incluye horas pasadas de hoy.
    const citas = await repo.citasPorFecha(tenant.id, fecha);
    const espacios = espaciosPorEmpleado(tenant, fecha, servicioId, citas);
    const espacio = espacios.find((e) => e.hora === hora);
    if (!espacio) {
      return JSON.stringify({
        ok: false,
        motivo: "ese horario ya no está disponible",
        disponibles: espacios.map((e) => e.hora),
      });
    }

    // Con quién se atiende (ALTO-07). Si el cliente pidió a alguien, se respeta pero se
    // verifica que esa persona tenga LIBRE ese horario — el modelo puede arrastrar un id
    // de un turno anterior, o el horario pudo ocuparse mientras conversaban. Si no pidió
    // a nadie, se asigna al primero libre. Sin equipo cargado queda undefined y todo se
    // comporta como antes.
    const pedido = empleadoPedido(args.empleadoId);
    let empleadoId: string | undefined;
    if (hayEquipo) {
      if (pedido) {
        if (!nombreEmpleado(pedido)) {
          return JSON.stringify({ ok: false, motivo: `no existe nadie con el id "${pedido}" en este negocio.` });
        }
        if (!espacio.empleados.includes(pedido)) {
          const otrosHorarios = espacios.filter((e) => e.empleados.includes(pedido)).map((e) => e.hora);
          return JSON.stringify({
            ok: false,
            motivo: `${nombreEmpleado(pedido)} no tiene libre ese horario. Ofrecele otro horario de esa persona, o la misma hora con alguien más.`,
            disponiblesDeEsaPersona: otrosHorarios,
            disponiblesDeOtros: espacio.empleados.map((id) => ({ empleadoId: id, nombre: nombreEmpleado(id) })),
          });
        }
        empleadoId = pedido;
      } else {
        empleadoId = espacio.empleados[0];
      }
    }

    let cita: Cita;
    try {
      cita = await repo.crearCita({
        tenantId: tenant.id,
        clienteWa,
        clienteNombre: String(args.nombre),
        servicioId,
        empleadoId,
        fecha,
        hora,
        placa: args.placa ? String(args.placa) : undefined,
        precio: precioDeCita(
          tenant.servicios.find((s) => s.id === servicioId),
          args.precio,
        ),
      });
    } catch (e) {
      // Perdió la carrera contra otro cliente que reservó a la misma persona en el mismo
      // instante: el índice único la frenó. Es un "no está disponible", no un error.
      if (esChoqueDeEmpleado(e)) {
        return JSON.stringify({
          ok: false,
          motivo: "justo se acaba de ocupar ese horario. Pedile disculpas y ofrecele otro.",
          disponibles: espacios.filter((x) => x.hora !== hora).map((x) => x.hora),
        });
      }
      throw e;
    }

    // Reflejar la cita en el Google Calendar del negocio (si está configurado).
    // Si Google falla, la cita YA quedó guardada: no se bloquea la respuesta.
    await sincronizarCreacionGcal(tenant, repo, cita);

    // Rescate de cotizaciones (Carril D, 1.1): si el cliente tenía una cotización
    // activa para este servicio, esta cita la cierra (agendada o recuperada). No
    // bloquea la respuesta al cliente si falla.
    if (tenantPuede(tenant, "rescateCotizaciones")) {
      await repo
        .actualizarCotizacionPorCita(tenant.id, clienteWa, servicioId, cita.id, cita.precio)
        .catch((e) => console.error("[rescate] actualizarCotizacionPorCita:", e));
    }

    // Upsell inteligente al agendar (Carril D, 1.2): si el servicio tiene un add-on
    // configurado y el cliente no lo rechazó hace <60 días, se lo sugerimos al modelo
    // para que lo ofrezca UNA vez en el mismo cierre. No bloquea la respuesta si falla.
    let addonSugerido: { addonId: string; nombre: string; precioPromo?: number } | undefined;
    if (tenantPuede(tenant, "upsell")) {
      const servicioBase = tenant.servicios.find((s) => s.id === servicioId);
      const addonServicio = servicioBase?.addonActivo
        ? tenant.servicios.find((s) => s.id === servicioBase.addonSugeridoId)
        : undefined;
      if (addonServicio) {
        const rechazadoReciente = await repo
          .fueRechazadoAddonRecientemente(tenant.id, clienteWa, addonServicio.id, hoyEnTz(tenant.timezone))
          .catch(() => false); // ante la duda, mejor ofrecerlo que perderse la venta
        if (!rechazadoReciente) {
          addonSugerido = { addonId: addonServicio.id, nombre: addonServicio.nombre, precioPromo: servicioBase!.addonPrecioPromo };
        }
      }
    }

    return JSON.stringify({ ok: true, cita, addonSugerido });
  }

  // Nombre legible del servicio para las respuestas de las herramientas de cita.
  const nombreServicio = (servicioId: string) =>
    tenant.servicios.find((s) => s.id === servicioId)?.nombre ?? servicioId;
  const citaResumen = (c: Cita) => ({
    citaId: c.id,
    servicio: nombreServicio(c.servicioId),
    fecha: c.fecha,
    hora: c.hora,
    placa: c.placa,
  });

  if (nombre === "consultar_mi_cita") {
    const activas = await repo.citasActivasCliente(tenant.id, clienteWa, hoyEnTz(tenant.timezone));
    return JSON.stringify({
      ok: true,
      cantidad: activas.length,
      citas: activas.map(citaResumen),
      mensaje: activas.length ? "Estas son las citas activas del cliente." : "El cliente no tiene citas activas.",
    });
  }

  if (nombre === "reprogramar_cita" || nombre === "cancelar_cita") {
    const activas = await repo.citasActivasCliente(tenant.id, clienteWa, hoyEnTz(tenant.timezone));
    if (activas.length === 0) {
      return JSON.stringify({ ok: false, motivo: "el cliente no tiene ninguna cita activa para modificar." });
    }
    // Resolver a CUÁL cita se refiere: por citaId si se dio, si no la única activa;
    // si hay varias y no especificó, devolver la lista para que el bot pregunte.
    const citaIdArg = args.citaId ? String(args.citaId) : undefined;
    let objetivo = activas.length === 1 ? activas[0] : undefined;
    if (citaIdArg) objetivo = activas.find((c) => c.id === citaIdArg);
    if (!objetivo) {
      return JSON.stringify({
        ok: false,
        motivo: citaIdArg
          ? "no encontré esa cita entre las activas del cliente."
          : "el cliente tiene varias citas activas; preguntale cuál y pasá el citaId.",
        citas: activas.map(citaResumen),
      });
    }

    if (nombre === "cancelar_cita") {
      const cancelada = await repo.cancelarCita(tenant.id, objetivo.id);
      if (!cancelada) return JSON.stringify({ ok: false, motivo: "no se pudo cancelar la cita." });
      await sincronizarCancelacionGcal(tenant, cancelada);
      return JSON.stringify({ ok: true, cancelada: citaResumen(cancelada) });
    }

    // reprogramar_cita
    const fecha = String(args.fecha);
    const hora = String(args.hora);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return JSON.stringify({ ok: false, motivo: "formato inválido: usá fecha YYYY-MM-DD y hora HH:mm (24h)." });
    }
    if (fecha < hoyEnTz(tenant.timezone)) {
      return JSON.stringify({ ok: false, motivo: "no se puede reprogramar a una fecha pasada." });
    }
    // Verificar que el nuevo espacio esté libre, EXCLUYENDO la propia cita (para que
    // no se bloquee a sí misma si se mueve dentro del mismo día).
    const citasFecha = (await repo.citasPorFecha(tenant.id, fecha)).filter((c) => c.id !== objetivo!.id);
    const espaciosRe = espaciosPorEmpleado(tenant, fecha, objetivo.servicioId, citasFecha);
    // La cita se mueve CON su persona: reprogramar no es cambiar de profesional. Si esa
    // persona no tiene libre el nuevo horario, se rechaza aunque el negocio sí lo tenga
    // (otro compañero libre no sirve: el cliente ya tiene con quién).
    const espacioRe = espaciosRe.find(
      (e) => e.hora === hora && (!objetivo!.empleadoId || e.empleados.includes(objetivo!.empleadoId)),
    );
    if (!espacioRe) {
      const propios = objetivo.empleadoId
        ? espaciosRe.filter((e) => e.empleados.includes(objetivo!.empleadoId!)).map((e) => e.hora)
        : espaciosRe.map((e) => e.hora);
      return JSON.stringify({
        ok: false,
        motivo: objetivo.empleadoId
          ? `${nombreEmpleado(objetivo.empleadoId) ?? "esa persona"} no tiene libre ese horario.`
          : "ese horario no está disponible",
        disponibles: propios,
      });
    }
    let actualizada: Cita | null;
    try {
      actualizada = await repo.reprogramarCita(tenant.id, objetivo.id, fecha, hora);
    } catch (e) {
      // Mismo caso de carrera que en agendar_cita: alguien tomó ese horario de esa
      // persona entre el chequeo y el UPDATE, y el índice único lo frenó.
      if (esChoqueDeEmpleado(e)) {
        return JSON.stringify({ ok: false, motivo: "justo se acaba de ocupar ese horario. Ofrecele otro." });
      }
      throw e;
    }
    if (!actualizada) return JSON.stringify({ ok: false, motivo: "no se pudo reprogramar la cita." });
    // Reflejar el cambio en Google Calendar (si está configurado y la cita tiene evento).
    await sincronizarReprogramacionGcal(tenant, actualizada);
    return JSON.stringify({ ok: true, cita: citaResumen(actualizada) });
  }

  if (nombre === "registrar_cotizacion") {
    const servicioId = String(args.servicioId);
    const monto = Number(args.monto);
    // Fallo silencioso (ok:false sin motivo): esta tool no tiene efecto conversacional,
    // el modelo no necesita reaccionar a que no se haya podido registrar.
    if (!servicioEsAgendable(servicioId) || !Number.isFinite(monto) || monto <= 0) {
      return JSON.stringify({ ok: false });
    }
    if (tenantPuede(tenant, "rescateCotizaciones") && tenant.rescateActivo) {
      await repo
        .registrarCotizacion(tenant.id, clienteWa, servicioId, monto)
        .catch((e) => console.error("[rescate] registrarCotizacion:", e));
    }
    return JSON.stringify({ ok: true });
  }

  if (nombre === "agregar_addon_a_cita" || nombre === "rechazar_addon") {
    const citaId = String(args.citaId);
    const addonId = String(args.addonId);
    // Validamos citaId/addonId contra la config del tenant en vez de confiar en lo
    // que pasa el modelo: la cita debe ser del cliente y el addonId debe ser
    // EXACTAMENTE el que está configurado para el servicio de esa cita (evita que
    // el modelo agregue un add-on arbitrario o con un precio inventado).
    const activas = await repo.citasActivasCliente(tenant.id, clienteWa, hoyEnTz(tenant.timezone));
    const cita = activas.find((c) => c.id === citaId);
    if (!cita) return JSON.stringify({ ok: false, motivo: "no encontré esa cita entre las activas del cliente." });
    const servicioBase = tenant.servicios.find((s) => s.id === cita.servicioId);
    if (!servicioBase?.addonActivo || servicioBase.addonSugeridoId !== addonId) {
      return JSON.stringify({ ok: false, motivo: "ese add-on no corresponde a esta cita." });
    }

    if (nombre === "rechazar_addon") {
      await repo.registrarRechazoAddon(tenant.id, clienteWa, addonId);
      return JSON.stringify({ ok: true });
    }

    const precio = servicioBase.addonPrecioPromo ?? tenant.servicios.find((s) => s.id === addonId)?.precio ?? 0;
    const actualizada = await repo.agregarAddonACita(tenant.id, citaId, { servicioId: addonId, precio });
    if (!actualizada) return JSON.stringify({ ok: false, motivo: "no se pudo agregar el add-on." });
    return JSON.stringify({ ok: true, cita: citaResumen(actualizada) });
  }

  return JSON.stringify({ error: `herramienta desconocida: ${nombre}` });
}

export interface ResultadoAgente {
  respuesta: string;
  fueraDeAlcance: boolean;
  /** El bot no pudo resolver y pidió pasar la conversación a una persona. */
  escalar: boolean;
  /** Motivo breve del traspaso (contexto para el operador). */
  motivo?: string;
  /**
   * Mensaje interactivo (botones/lista) a enviar EN LUGAR del texto plano: su
   * `cuerpo` se rellena con `respuesta`. Lo produce una herramienta (ofrecer_horarios).
   */
  interactivo?: MensajeInteractivo;
  /**
   * Confirmación fija de lo que YA quedó guardado en este turno (cita agendada,
   * reprogramada o cancelada). Viene junto a `escalar: true` cuando el modelo
   * escaló DESPUÉS de una acción exitosa: handleWebhook la manda antes del aviso de
   * traspaso, para que el cliente no crea que la cita no quedó (revisión pre-venta).
   */
  confirmacion?: string;
}

/** "2026-06-12" → "viernes 12 de junio". */
function fechaLegible(fecha: string, timezone: string): string {
  try {
    return new Date(`${fecha}T12:00:00`).toLocaleDateString("es", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: timezone,
    });
  } catch {
    return fecha;
  }
}

/**
 * Texto FIJO (no lo redacta el modelo) que confirma una acción de agenda que ya
 * quedó persistida en este turno, o null si la tool no modificó nada. Es la red de
 * seguridad de la revisión pre-venta 2026-10: si después de `agendar_cita` el turno
 * termina en escalada, en "se agotaron los pasos" o en un error de OpenAI, el
 * cliente igual se entera de que su cita quedó (antes recibía "tuvimos un
 * problemita", reintentaba y dejaba citas duplicadas).
 */
export function confirmacionDeAccion(nombreTool: string, resultado: string, tenant: Tenant): string | null {
  let r: any;
  try {
    r = JSON.parse(resultado);
  } catch {
    return null;
  }
  if (r?.ok !== true) return null;
  const nombreServicio = (id: string) => tenant.servicios.find((s) => s.id === id)?.nombre ?? id;
  if (nombreTool === "agendar_cita" && r.cita) {
    const c = r.cita;
    return `✅ Tu cita quedó agendada: ${nombreServicio(c.servicioId)}, ${fechaLegible(c.fecha, tenant.timezone)} a las ${c.hora}.`;
  }
  if (nombreTool === "reprogramar_cita" && r.cita) {
    const c = r.cita;
    return `✅ Tu cita quedó cambiada: ${c.servicio}, ${fechaLegible(c.fecha, tenant.timezone)} a las ${c.hora}.`;
  }
  if (nombreTool === "cancelar_cita" && r.cancelada) {
    const c = r.cancelada;
    return `Tu cita de ${c.servicio} del ${fechaLegible(c.fecha, tenant.timezone)} quedó cancelada.`;
  }
  return null;
}

/**
 * Procesa un mensaje del cliente y devuelve la respuesta del agente.
 * `historial` son los mensajes previos de la conversación (para contexto).
 * `imagenDataUrl` (C1.5): si el cliente mandó una foto, se adjunta SOLO al turno
 * actual como contenido multimodal (gpt-4o-mini soporta visión) — no se guarda en
 * el historial de turnos siguientes para no repetir el mismo blob en cada llamada.
 */
export async function correrAgente(
  ctx: ContextoAgente,
  textoUsuario: string,
  historial: MensajeConversacion[],
  imagenDataUrl?: string,
): Promise<ResultadoAgente> {
  const inicio = Date.now();
  try {
    return await correrAgenteInterno(ctx, textoUsuario, historial, imagenDataUrl);
  } finally {
    registrarLatenciaAgente(ctx.tenant.id, Date.now() - inicio);
  }
}

/**
 * Nivel de detalle de las fotos que van a visión (revisión pre-venta 2026-10). Con
 * "low" OpenAI procesa la imagen a 512x512 con un costo fijo y chico de tokens; con
 * "high"/"auto" una foto de celular se parte en muchos tiles y cuesta varias veces
 * más. Para cotizar un lavado (¿sedán o SUV?, ¿qué tan sucio?) "low" alcanza.
 * Configurable por `OPENAI_VISION_DETALLE` (low | high | auto), default "low".
 */
export function detalleVision(): "low" | "high" | "auto" {
  const v = process.env.OPENAI_VISION_DETALLE?.trim().toLowerCase();
  return v === "high" || v === "auto" ? v : "low";
}

async function correrAgenteInterno(
  ctx: ContextoAgente,
  textoUsuario: string,
  historial: MensajeConversacion[],
  imagenDataUrl?: string,
): Promise<ResultadoAgente> {
  const contenidoUsuario: string | ChatCompletionContentPart[] = imagenDataUrl
    ? [
        { type: "text", text: textoUsuario },
        { type: "image_url", image_url: { url: imagenDataUrl, detail: detalleVision() } },
      ]
    : textoUsuario;

  const mensajes: ChatCompletionMessageParam[] = [
    { role: "system", content: construirSystemPrompt(ctx.tenant) },
    ...historial.map((m) => ({ role: m.rol, content: m.contenido }) as ChatCompletionMessageParam),
    { role: "user", content: contenidoUsuario },
  ];

  // Canal de salida lateral para efectos de herramientas (mensaje interactivo).
  const capturas: { interactivo?: MensajeInteractivo } = {};

  // Costo de LLM por tenant (F13 — PLAN-ESCALA-MULTITENANT.md). Un turno puede hacer
  // hasta MAX_PASOS llamadas al modelo (tool-calling): se suma el `usage` de CADA paso
  // acá abajo y se registra UNA sola vez al terminar el turno, sea cual sea la salida
  // (respuesta final, escalada, o el fallback de "se agotaron los pasos") — por eso el
  // registro vive en el `finally`, que corre para los tres `return` de más abajo.
  let tokensEntrada = 0;
  let tokensSalida = 0;
  // Acciones de agenda que YA quedaron guardadas en este turno (ver `confirmacionDeAccion`).
  const confirmaciones: string[] = [];
  const confirmacion = () => (confirmaciones.length ? confirmaciones.join("\n") : undefined);
  try {
    for (let paso = 0; paso < MAX_PASOS; paso++) {
      let res;
      try {
        res = await getOpenAI().chat.completions.create({
          model: MODELO,
          messages: mensajes,
          tools: TOOLS,
          temperature: 0.3,
        });
      } catch (e) {
        // OpenAI falló DESPUÉS de una acción ya guardada: el cliente recibe la
        // confirmación fija en vez de "tuvimos un problemita" (que lo haría reintentar
        // y duplicar la cita). Sin acciones previas, se propaga como siempre.
        if (!confirmaciones.length) throw e;
        console.error("[agente] OpenAI falló tras una acción ya guardada; se confirma con texto fijo:", e);
        return { respuesta: confirmacion()!, fueraDeAlcance: false, escalar: false };
      }
      // `usage` puede faltar en respuestas raras del SDK (streaming/errores parciales);
      // no rompemos el turno del cliente por un dato de costeo que falte.
      if (res.usage) {
        tokensEntrada += res.usage.prompt_tokens ?? 0;
        tokensSalida += res.usage.completion_tokens ?? 0;
      }

      const msg = res.choices[0].message;
      mensajes.push(msg);

      if (!msg.tool_calls?.length) {
        const respuesta = msg.content ?? "Disculpá, no entendí. ¿Me lo repetís?";
        const fueraDeAlcance = /solo puedo ayudarte con/i.test(respuesta);
        return { respuesta, fueraDeAlcance, escalar: false, interactivo: capturas.interactivo };
      }

      for (const call of msg.tool_calls) {
        // En openai 6.x, tool_calls puede incluir herramientas "custom"; solo procesamos las de tipo "function".
        if (call.type !== "function") continue;
        // Escalada a humano: el modelo decidió que no puede resolverlo. Cortamos el agente
        // acá (no mandamos respuesta del bot) y señalamos el traspaso para handleWebhook.
        if (call.function.name === "escalar_a_humano") {
          let motivo = "";
          try {
            motivo = String(JSON.parse(call.function.arguments || "{}").motivo ?? "");
          } catch {
            // sin motivo legible: igual escalamos
          }
          return { respuesta: "", fueraDeAlcance: false, escalar: true, motivo, confirmacion: confirmacion() };
        }
        let resultado: string;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          resultado = await ejecutarTool(call.function.name, args, ctx, capturas);
          const conf = confirmacionDeAccion(call.function.name, resultado, ctx.tenant);
          if (conf) confirmaciones.push(conf);
        } catch (e) {
          resultado = JSON.stringify({ error: String(e) });
        }
        mensajes.push({ role: "tool", tool_call_id: call.id, content: resultado });
      }
    }

    // Se agotaron los pasos de tool-calling sin una respuesta final. Si en el camino
    // ya quedó guardada una acción (p. ej. `agendar_cita` en el último paso), se
    // confirma con texto fijo: el pedido del cliente SÍ se resolvió.
    if (confirmaciones.length) {
      return { respuesta: confirmacion()!, fueraDeAlcance: false, escalar: false };
    }
    // Si no, el bot quedó trabado → lo pasamos a una persona (en vez de dejar al
    // cliente sin solución).
    return {
      respuesta: "",
      fueraDeAlcance: false,
      escalar: true,
      motivo: "el bot no pudo completar la solicitud",
    };
  } finally {
    // Fire-and-forget (ver observabilidad/uso.ts): nunca debe agregar latencia a la
    // respuesta ya calculada arriba ni tumbar el turno si la base falla.
    registrarUsoLlm(ctx.tenant.id, tokensEntrada, tokensSalida, calcularCostoMillonesimos(MODELO, tokensEntrada, tokensSalida));
  }
}
