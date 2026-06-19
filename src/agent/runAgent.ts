import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MensajeConversacion, Repositorio, Tenant } from "../types";
import { construirSystemPrompt } from "./systemPrompt";
import { TOOLS } from "./tools";
import { espaciosDisponibles } from "../booking/availability";
import { calendarioConfigurado, crearEventoCita } from "../calendar/googleCalendar";

const MODELO = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_PASOS = 4; // tope de iteraciones de tool-calling por mensaje

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

/** Ejecuta una herramienta pedida por el modelo y devuelve el resultado (string JSON). */
async function ejecutarTool(
  nombre: string,
  args: Record<string, unknown>,
  ctx: ContextoAgente,
): Promise<string> {
  const { tenant, repo, clienteWa } = ctx;

  // Candado: solo se agendan servicios marcados como agendables (pulidos).
  const servicioEsAgendable = (servicioId: string) =>
    tenant.servicios.some((s) => s.id === servicioId && s.agendable);

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

  return JSON.stringify({ error: `herramienta desconocida: ${nombre}` });
}

export interface ResultadoAgente {
  respuesta: string;
  fueraDeAlcance: boolean;
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
      return { respuesta, fueraDeAlcance };
    }

    for (const call of msg.tool_calls) {
      // En openai 6.x, tool_calls puede incluir herramientas "custom"; solo procesamos las de tipo "function".
      if (call.type !== "function") continue;
      let resultado: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        resultado = await ejecutarTool(call.function.name, args, ctx);
      } catch (e) {
        resultado = JSON.stringify({ error: String(e) });
      }
      mensajes.push({ role: "tool", tool_call_id: call.id, content: resultado });
    }
  }

  return {
    respuesta: "Disculpá, no pude completar eso. Un encargado te va a contactar pronto 🙂",
    fueraDeAlcance: false,
  };
}
