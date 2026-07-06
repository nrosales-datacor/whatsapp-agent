import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Cita, MensajeConversacion, MensajeInteractivo, Repositorio, Tenant } from "../types";
import { construirSystemPrompt } from "./systemPrompt";
import { TOOLS } from "./tools";
import { opcionHorario } from "../whatsapp/client";
import { espaciosDisponibles } from "../booking/availability";
import {
  actualizarEventoCita,
  calendarioConfigurado,
  crearEventoCita,
  eliminarEventoCita,
} from "../calendar/googleCalendar";

const MODELO = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_PASOS = 4; // tope de iteraciones de tool-calling por mensaje

/** "Hoy" ("YYYY-MM-DD") en la zona horaria del tenant (para filtrar citas futuras). */
function hoyEnTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Inicialización perezosa: el server arranca aunque todavía no haya OPENAI_API_KEY;
// solo se necesita cuando llega un mensaje real.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI(); // toma OPENAI_API_KEY del entorno
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
 * Ejecuta una herramienta pedida por el modelo y devuelve el resultado (string JSON).
 * `capturas` es un canal de salida lateral: algunas herramientas (p. ej.
 * `ofrecer_horarios`) no solo informan al modelo, sino que dejan un efecto para
 * handleWebhook (mandar un mensaje interactivo). Se rellena, no se devuelve al modelo.
 */
async function ejecutarTool(
  nombre: string,
  args: Record<string, unknown>,
  ctx: ContextoAgente,
  capturas: { interactivo?: MensajeInteractivo },
): Promise<string> {
  const { tenant, repo, clienteWa } = ctx;

  // Candado: solo se agendan servicios marcados como agendables (pulidos).
  const servicioEsAgendable = (servicioId: string) =>
    tenant.servicios.some((s) => s.id === servicioId && s.agendable);

  if (nombre === "ofrecer_horarios") {
    const fecha = String(args.fecha);
    const servicioId = String(args.servicioId);
    const franja = args.franja ? String(args.franja) : "todos";
    if (!servicioEsAgendable(servicioId)) {
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda; los lavados son por orden de llegada. Solo los pulidos requieren cita.",
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return JSON.stringify({ ok: false, motivo: "formato de fecha inválido: usá YYYY-MM-DD." });
    }
    const citas = await repo.citasPorFecha(tenant.id, fecha);
    let libres = espaciosDisponibles(tenant, fecha, servicioId, citas);
    if (franja === "mañana") libres = libres.filter((h) => Number(h.slice(0, 2)) < 12);
    else if (franja === "tarde") libres = libres.filter((h) => Number(h.slice(0, 2)) >= 12);
    if (libres.length === 0) {
      return JSON.stringify({
        ok: false,
        motivo: "no hay horarios disponibles para esa fecha/franja; ofrecé otra fecha o franja.",
        disponibles: [],
      });
    }
    const mostrados = libres.slice(0, MAX_FILAS_LISTA);
    const truncado = libres.length > MAX_FILAS_LISTA;
    capturas.interactivo = {
      tipo: "lista",
      cuerpo: "", // handleWebhook lo rellena con la frase que redacte el agente.
      textoBoton: "Ver horarios",
      opciones: mostrados.map((h) => opcionHorario(fecha, h)),
    };
    return JSON.stringify({
      ok: true,
      mostrados: mostrados.length,
      total: libres.length,
      truncado,
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
        motivo: "ese servicio no se agenda; los lavados son por orden de llegada. Solo los pulidos requieren cita.",
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
      return JSON.stringify({
        ok: false,
        motivo: "ese servicio no se agenda; los lavados son por orden de llegada.",
      });
    }
    // Validar el formato de fecha/hora ANTES de persistir: la cita se muestra en el
    // panel, así que un valor con formato raro no debe colarse (defensa en profundidad
    // contra inyección por la ficha del cliente).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return JSON.stringify({ ok: false, motivo: "formato inválido: usá fecha YYYY-MM-DD y hora HH:mm (24h)." });
    }
    // Validar que el espacio siga libre antes de crear (evita doble reserva).
    const citas = await repo.citasPorFecha(tenant.id, fecha);
    const libres = espaciosDisponibles(tenant, fecha, servicioId, citas);
    if (!libres.includes(hora)) {
      return JSON.stringify({ ok: false, motivo: "ese horario ya no está disponible", disponibles: libres });
    }
    const cita = await repo.crearCita({
      tenantId: tenant.id,
      clienteWa,
      clienteNombre: String(args.nombre),
      servicioId,
      fecha,
      hora,
      placa: args.placa ? String(args.placa) : undefined,
      precio: args.precio != null && !Number.isNaN(Number(args.precio)) ? Number(args.precio) : undefined,
    });

    // Reflejar la cita en el Google Calendar del negocio (si está configurado).
    // Si Google falla, la cita YA quedó guardada: no se bloquea la respuesta.
    if (calendarioConfigurado()) {
      try {
        const eventId = await crearEventoCita(tenant, cita);
        if (eventId) await repo.guardarGcalEventId(cita.id, eventId);
      } catch (e) {
        console.error(`[gcal] no se pudo crear el evento de la cita ${cita.id}:`, e);
      }
    }

    return JSON.stringify({ ok: true, cita });
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
      if (cancelada.gcalEventId) {
        try {
          await eliminarEventoCita(cancelada.gcalEventId);
        } catch (e) {
          console.error(`[gcal] no se pudo borrar el evento de la cita ${cancelada.id}:`, e);
        }
      }
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
    const libres = espaciosDisponibles(tenant, fecha, objetivo.servicioId, citasFecha);
    if (!libres.includes(hora)) {
      return JSON.stringify({ ok: false, motivo: "ese horario no está disponible", disponibles: libres });
    }
    const actualizada = await repo.reprogramarCita(tenant.id, objetivo.id, fecha, hora);
    if (!actualizada) return JSON.stringify({ ok: false, motivo: "no se pudo reprogramar la cita." });
    // Reflejar el cambio en Google Calendar (si está configurado y la cita tiene evento).
    if (calendarioConfigurado() && actualizada.gcalEventId) {
      try {
        await actualizarEventoCita(tenant, actualizada);
      } catch (e) {
        console.error(`[gcal] no se pudo actualizar el evento de la cita ${actualizada.id}:`, e);
      }
    }
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
}

/**
 * Procesa un mensaje del cliente y devuelve la respuesta del agente.
 * `historial` son los mensajes previos de la conversación (para contexto).
 */
export async function correrAgente(
  ctx: ContextoAgente,
  textoUsuario: string,
  historial: MensajeConversacion[],
): Promise<ResultadoAgente> {
  const mensajes: ChatCompletionMessageParam[] = [
    { role: "system", content: construirSystemPrompt(ctx.tenant) },
    ...historial.map((m) => ({ role: m.rol, content: m.contenido }) as ChatCompletionMessageParam),
    { role: "user", content: textoUsuario },
  ];

  // Canal de salida lateral para efectos de herramientas (mensaje interactivo).
  const capturas: { interactivo?: MensajeInteractivo } = {};

  for (let paso = 0; paso < MAX_PASOS; paso++) {
    const res = await getOpenAI().chat.completions.create({
      model: MODELO,
      messages: mensajes,
      tools: TOOLS,
      temperature: 0.3,
    });

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
        return { respuesta: "", fueraDeAlcance: false, escalar: true, motivo };
      }
      let resultado: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        resultado = await ejecutarTool(call.function.name, args, ctx, capturas);
      } catch (e) {
        resultado = JSON.stringify({ error: String(e) });
      }
      mensajes.push({ role: "tool", tool_call_id: call.id, content: resultado });
    }
  }

  // Se agotaron los pasos de tool-calling sin una respuesta final: el bot quedó
  // trabado → lo pasamos a una persona (en vez de dejar al cliente sin solución).
  return {
    respuesta: "",
    fueraDeAlcance: false,
    escalar: true,
    motivo: "el bot no pudo completar la solicitud",
  };
}
