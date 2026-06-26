import type { Conversacion, MensajeConversacion, Repositorio, Tenant } from "./types";
import { obtenerTenantPorPhoneNumberId, refrescarSiFaltaPhoneNumberId } from "./config/tenantStore";
import { parsearEntrante, enviarTexto, type MensajeEntrante } from "./whatsapp/client";
import { correrAgente } from "./agent/runAgent";
import { notificarOperador } from "./panel/notificaciones";

// Aviso de transparencia que se manda UNA vez por cliente (cumple opt-in/política).
const AVISO_BOT =
  "👋 ¡Hola! Soy el asistente automatizado de %NOMBRE%. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.";

// Resultado de la fase de ingesta: lo que quedó listo (y ya persistido) para responder.
type Pendiente =
  | { clase: "no-texto"; tenant: Tenant; entrante: MensajeEntrante; conv: Conversacion }
  | {
      clase: "texto";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
    };

/**
 * FASE 1 — rápida, se ejecuta ANTES de responder 200 a Meta.
 * Valida el evento, persiste el mensaje entrante y deduplica reintentos. Si esto
 * lanza, el server NO responde 200 y Meta reintrega; como guardamos por waMessageId,
 * el reintento no genera duplicados. Devuelve null si no hay nada que responder
 * (evento ignorado, número sin tenant, o mensaje duplicado).
 */
export async function ingerirEntrante(body: unknown, repo: Repositorio): Promise<Pendiente | null> {
  const entrante = parsearEntrante(body);
  if (!entrante) return null; // status u otro evento que no nos interesa

  const tenant = obtenerTenantPorPhoneNumberId(entrante.phoneNumberId);
  if (!tenant) {
    console.warn("[webhook] mensaje a un phone_number_id sin tenant:", entrante.phoneNumberId);
    // Quizás es un negocio recién dado de alta que el caché aún no tiene: gatilla un
    // refresh (fire-and-forget, con cooldown) para tomarlo en el próximo mensaje.
    refrescarSiFaltaPhoneNumberId(entrante.phoneNumberId);
    return null;
  }

  // Por ahora solo manejamos texto. Igual guardamos un marcador (deduplicado por
  // waMessageId) para que el operador vea que llegó algo y para no enviar el aviso
  // "solo texto" dos veces ante un reintento de Meta.
  if (!entrante.esTexto || !entrante.texto.trim()) {
    const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
    const esNuevo = await repo.guardarMensaje(conv.id, {
      rol: "user",
      contenido: "[mensaje no de texto]",
      creadoEn: new Date().toISOString(),
      waMessageId: entrante.messageId,
    });
    if (!esNuevo) return null;
    return { clase: "no-texto", tenant, entrante, conv };
  }

  console.log(`[entrante] ${entrante.clienteWa}: "${entrante.texto.slice(0, 80)}"`);

  const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
  const primerContacto = !conv.optInEn;
  // Snapshot del historial ANTES de guardar el turno actual: el agente recibe el
  // contexto previo y agrega el mensaje del usuario una sola vez (evita duplicarlo,
  // que es lo que pasaba cuando el repo devolvía el array vivo ya con el mensaje).
  const historialPrevio = conv.mensajes.slice();

  const esNuevo = await repo.guardarMensaje(conv.id, {
    rol: "user",
    contenido: entrante.texto,
    creadoEn: new Date().toISOString(),
    waMessageId: entrante.messageId,
  });
  if (!esNuevo) {
    console.log(`[webhook] mensaje duplicado ignorado (${entrante.messageId ?? "sin id"})`);
    return null;
  }

  return { clase: "texto", tenant, entrante, conv, primerContacto, historialPrevio };
}

/**
 * FASE 2 — puede tardar (llama al LLM y a la API de WhatsApp). Se ejecuta DESPUÉS
 * de responder 200. El mensaje entrante ya quedó guardado en la fase 1, así que
 * aunque esto falle no se pierde.
 */
export async function responderEntrante(p: Pendiente, repo: Repositorio): Promise<void> {
  if (p.clase === "no-texto") {
    // El bot no puede leer fotos/audios/stickers. Le pedimos al cliente que
    // escriba en qué ayudarle Y avisamos a un humano: el adjunto puede ser
    // importante (p. ej. la foto del parabrisas a pulir) y no queremos ignorarlo.
    await enviarTexto(
      p.tenant,
      p.entrante.clienteWa,
      "¡Hola! 🙂 Por ahora no puedo ver fotos, audios ni stickers. Contame por texto en qué te puedo ayudar (precios, horarios, ubicación o agendar una cita) y con gusto te atiendo.",
    ).catch((e) => console.error("[no-texto] no se pudo responder al cliente:", e));
    await notificarOperador(
      repo,
      p.tenant,
      p.conv,
      "📎 Llegó un mensaje multimedia que el bot no puede leer (foto/audio/sticker).",
    ).catch((e) => console.error("[no-texto] notificarOperador:", e));
    return;
  }

  const { tenant, entrante, conv, primerContacto, historialPrevio } = p;

  // Si la conversación YA está en modo humano, el bot NO responde: el mensaje ya
  // quedó guardado; solo avisamos al operador para que conteste del panel.
  if (conv.modo === "humano") {
    console.log(`[humano] ${entrante.clienteWa}: bot en pausa, atiende una persona`);
    await notificarOperador(repo, tenant, conv, entrante.texto).catch((e) =>
      console.error("[humano] notificarOperador:", e),
    );
    return;
  }

  // Escotilla de salida humana: si pide "agente", pasamos la conversación a modo humano.
  if (/\bagente\b|\bhumano\b|\bpersona\b/i.test(entrante.texto)) {
    try {
      await repo.setModoConversacion(tenant.id, conv.id, "humano");
      await enviarTexto(
        tenant,
        entrante.clienteWa,
        "¡Listo! Te paso con una persona del equipo. En un momento te responden por acá. 🙋",
      );
      await notificarOperador(repo, tenant, conv, entrante.texto);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: "fuera_de_alcance",
        detalle: "pidió humano",
      });
    } catch (e) {
      // La conversación ya quedó en humano: registramos el fallo para que el caso
      // no quede mudo (sin confirmación al cliente ni aviso al operador).
      console.error("[humano] no se pudo completar el traspaso:", e);
      await repo
        .registrarCalidad({
          tenantId: tenant.id,
          clienteWa: entrante.clienteWa,
          tipo: "error",
          detalle: "fallo en traspaso a humano: " + String(e),
        })
        .catch(() => {});
    }
    return;
  }

  try {
    const { respuesta, fueraDeAlcance } = await correrAgente(
      { tenant, repo, clienteWa: entrante.clienteWa },
      entrante.texto,
      historialPrevio,
    );

    // Mientras el LLM pensaba, un humano pudo tomar la conversación desde el panel.
    // Revalidamos el modo (lectura liviana) ANTES de hablar para no pisar a la persona.
    const modoActual = await repo.obtenerModo(tenant.id, conv.id);
    if (modoActual === "humano") {
      console.log(`[bot] respuesta descartada: un humano tomó ${entrante.clienteWa} durante el proceso`);
      return;
    }

    // En el primer contacto, anteponer el aviso de bot (transparencia + opt-in).
    let salida = respuesta;
    if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;

    // Enviar PRIMERO y persistir DESPUÉS: si el envío falla, no queda un mensaje
    // "fantasma" en el historial que el cliente nunca recibió (y el opt-in no se
    // marca, así el aviso se reintenta en el próximo mensaje).
    await enviarTexto(tenant, entrante.clienteWa, salida);
    if (primerContacto) await repo.marcarOptIn(conv.id);
    await repo.guardarMensaje(conv.id, {
      rol: "assistant",
      contenido: respuesta,
      creadoEn: new Date().toISOString(),
    });
    console.log(`[saliente] → ${entrante.clienteWa}: "${respuesta.slice(0, 80)}"${fueraDeAlcance ? " [fuera de alcance]" : ""}`);

    await repo.registrarCalidad({
      tenantId: tenant.id,
      clienteWa: entrante.clienteWa,
      tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
    });
  } catch (e) {
    console.error("[webhook] error procesando mensaje:", e);
    await repo.registrarCalidad({
      tenantId: tenant.id,
      clienteWa: entrante.clienteWa,
      tipo: "error",
      detalle: String(e),
    });
    await enviarTexto(
      tenant,
      entrante.clienteWa,
      "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏",
    ).catch(() => {});
    // Red de seguridad: avisar a un humano para que entre de una. Si el envío de
    // arriba también falló (p. ej. caída de WhatsApp), el cliente quedó sin
    // respuesta y no queremos que espere horas hasta que alguien lo note a mano.
    await notificarOperador(
      repo,
      tenant,
      conv,
      `⚠️ El bot no pudo responder a "${entrante.texto.slice(0, 60)}". Conviene atenderlo a mano.`,
    ).catch((e2) => console.error("[webhook] notificarOperador tras error:", e2));
  }
}

/**
 * Orquesta las dos fases en una sola llamada (cómodo para tests). El server las
 * llama por separado para responder 200 recién después de persistir el entrante.
 */
export async function manejarWebhook(body: unknown, repo: Repositorio): Promise<void> {
  const pendiente = await ingerirEntrante(body, repo);
  if (pendiente) await responderEntrante(pendiente, repo);
}
