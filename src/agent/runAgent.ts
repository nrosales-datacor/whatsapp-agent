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

  return JSON.stringify({ error: `herramienta desconocida: ${nombre}` });
}

export interface ResultadoAgente {
  respuesta: string;
  fueraDeAlcance: boolean;
  /** El bot no pudo resolver y pidió pasar la conversación a una persona. */
  escalar: boolean;
  /** Motivo breve del traspaso (contexto para el operador). */
  motivo?: string;
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
      return { respuesta, fueraDeAlcance, escalar: false };
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
        resultado = await ejecutarTool(call.function.name, args, ctx);
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
