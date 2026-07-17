import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Cita, MensajeConversacion, MensajeInteractivo, Repositorio, Tenant } from "../types";
import { construirSystemPrompt } from "./systemPrompt";
import { TOOLS } from "./tools";
import { opcionHorario } from "../whatsapp/client";
import { espaciosDisponibles } from "../booking/availability";
import {
  hoyEnTz,
  sincronizarCancelacionGcal,
  sincronizarCreacionGcal,
  sincronizarReprogramacionGcal,
} from "../booking/gestionCitas";
import { registrarLatenciaAgente } from "../observabilidad/metricas";
import { tenantPuede } from "../billing/planes";

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
      await sincronizarCancelacionGcal(cancelada);
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
    registrarLatenciaAgente(Date.now() - inicio);
  }
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
        { type: "image_url", image_url: { url: imagenDataUrl } },
      ]
    : textoUsuario;

  const mensajes: ChatCompletionMessageParam[] = [
    { role: "system", content: construirSystemPrompt(ctx.tenant) },
    ...historial.map((m) => ({ role: m.rol, content: m.contenido }) as ChatCompletionMessageParam),
    { role: "user", content: contenidoUsuario },
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
