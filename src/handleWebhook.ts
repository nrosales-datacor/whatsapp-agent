import type { Conversacion, MensajeConversacion, PendienteSerializado, Repositorio, Tenant } from "./types";
import { obtenerTenantPorPhoneNumberId, refrescarSiFaltaPhoneNumberId } from "./config/tenantStore";
import {
  parsearEntrante,
  enviarTexto,
  enviarInteractivo,
  esConfirmacionCita,
  respuestaPostServicio,
  descargarImagenComoDataUrl,
  type MensajeEntrante,
} from "./whatsapp/client";
import type { MensajeInteractivo } from "./types";
import { transcribirAudio } from "./whatsapp/transcribir";
import { correrAgente } from "./agent/runAgent";
import { notificarOperador } from "./panel/notificaciones";
import { registrarMensaje } from "./observabilidad/metricas";
import { registrarMensajeEntrante } from "./observabilidad/uso";

// "Conversación iniciada" ≈ primer mensaje tras 24 h de silencio (aproxima el modelo
// de cobro de Meta: una conversación = una ventana de 24 h), para los contadores de
// uso mensual por tenant (Carril D, 0.2).
const VENTANA_CONVERSACION_MS = 24 * 60 * 60 * 1000;
export function esConversacionIniciada(mensajesPrevios: MensajeConversacion[]): boolean {
  const ultimo = mensajesPrevios[mensajesPrevios.length - 1];
  if (!ultimo) return true;
  return Date.now() - new Date(ultimo.creadoEn).getTime() > VENTANA_CONVERSACION_MS;
}

// Aviso de transparencia que se manda UNA vez por cliente (cumple opt-in/política).
const AVISO_BOT =
  "👋 ¡Hola! Soy el asistente automatizado de %NOMBRE%. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.";

// Mensaje al cliente cuando el bot no pudo resolver y pasa el caso a una persona.
const MENSAJE_ESCALADA = "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.";

/**
 * Envía la respuesta del bot al cliente: como mensaje INTERACTIVO (botones/lista)
 * si el agente lo produjo, o como texto plano si no. El `cuerpo` del interactivo se
 * rellena con el texto que redactó el agente (la invitación a elegir).
 */
async function enviarRespuestaBot(
  tenant: Tenant,
  paraWa: string,
  texto: string,
  interactivo?: MensajeInteractivo,
): Promise<void> {
  if (interactivo) {
    await enviarInteractivo(tenant, paraWa, { ...interactivo, cuerpo: texto });
  } else {
    await enviarTexto(tenant, paraWa, texto);
  }
}

// Resultado de la fase de ingesta: lo que quedó listo (y ya persistido) para responder.
// Exportado para que el worker pueda reconstruirlo desde el payload serializado.
export type Pendiente =
  | { clase: "no-texto"; tenant: Tenant; entrante: MensajeEntrante; conv: Conversacion }
  | {
      clase: "audio";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
    }
  | {
      clase: "imagen";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
    }
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

  // Mensajes no-texto: audio (notas de voz) los transcribimos en fase 2, fotos las
  // cotizamos con visión (C1.5); el resto (stickers, video) se notifica al operador.
  // Igual guardamos un marcador deduplicado por waMessageId para que el operador
  // vea que llegó algo.
  if (!entrante.esTexto || !entrante.texto.trim()) {
    const esAudio = !!entrante.audioId;
    const esImagen = !!entrante.imagenId;
    const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
    const primerContacto = !conv.optInEn;
    const historialPrevio = conv.mensajes.slice();
    const msg: MensajeConversacion = {
      rol: "user",
      contenido: esAudio
        ? "[audio]"
        : esImagen
          ? entrante.imagenCaption
            ? `[foto] ${entrante.imagenCaption}`
            : "[foto]"
          : "[multimedia]",
      creadoEn: new Date().toISOString(),
      waMessageId: entrante.messageId,
    };
    const payload: PendienteSerializado = {
      clase: esAudio ? "audio" : esImagen ? "imagen" : "no-texto",
      tenantId: tenant.id,
      entrante,
      conv,
      ...(esAudio || esImagen ? { primerContacto, historialPrevio } : {}),
    };
    const esNuevo = await repo.guardarEntranteYEncolar(conv.id, msg, payload);
    if (!esNuevo) return null;
    registrarMensaje();
    registrarMensajeEntrante(tenant.id, esConversacionIniciada(historialPrevio));
    if (esAudio) return { clase: "audio", tenant, entrante, conv, primerContacto, historialPrevio };
    if (esImagen) return { clase: "imagen", tenant, entrante, conv, primerContacto, historialPrevio };
    return { clase: "no-texto", tenant, entrante, conv };
  }

  console.log(`[entrante] ${entrante.clienteWa}: "${entrante.texto.slice(0, 80)}"`);

  const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
  const primerContacto = !conv.optInEn;
  // Snapshot del historial ANTES de guardar el turno actual: el agente recibe el
  // contexto previo y agrega el mensaje del usuario una sola vez (evita duplicarlo,
  // que es lo que pasaba cuando el repo devolvía el array vivo ya con el mensaje).
  const historialPrevio = conv.mensajes.slice();

  const msg: MensajeConversacion = {
    rol: "user",
    contenido: entrante.texto,
    creadoEn: new Date().toISOString(),
    waMessageId: entrante.messageId,
  };
  const payload: PendienteSerializado = {
    clase: "texto",
    tenantId: tenant.id,
    entrante,
    conv,
    primerContacto,
    historialPrevio,
  };
  const esNuevo = await repo.guardarEntranteYEncolar(conv.id, msg, payload);
  if (!esNuevo) {
    console.log(`[webhook] mensaje duplicado ignorado (${entrante.messageId ?? "sin id"})`);
    return null;
  }
  registrarMensaje();
  registrarMensajeEntrante(tenant.id, esConversacionIniciada(historialPrevio));

  return { clase: "texto", tenant, entrante, conv, primerContacto, historialPrevio };
}

/**
 * FASE 2 — puede tardar (llama al LLM y a la API de WhatsApp). Se ejecuta DESPUÉS
 * de responder 200. El mensaje entrante ya quedó guardado en la fase 1, así que
 * aunque esto falle no se pierde.
 */
export async function responderEntrante(p: Pendiente, repo: Repositorio): Promise<void> {
  if (p.clase === "no-texto") {
    // El bot no puede leer stickers ni video (las fotos las procesa la rama
    // "imagen" de abajo, C1.5). Le pedimos al cliente que escriba en qué ayudarle
    // Y avisamos a un humano: el adjunto puede ser importante y no queremos ignorarlo.
    await enviarTexto(
      p.tenant,
      p.entrante.clienteWa,
      "¡Hola! 🙂 Por ahora no puedo ver stickers ni videos. Contame por texto (o mandame una foto) en qué te puedo ayudar y con gusto te atiendo.",
    ).catch((e) => console.error("[no-texto] no se pudo responder al cliente:", e));
    await notificarOperador(
      repo,
      p.tenant,
      p.conv,
      "📎 Llegó un mensaje multimedia que el bot no puede leer (sticker/video).",
    ).catch((e) => console.error("[no-texto] notificarOperador:", e));
    return;
  }

  if (p.clase === "imagen") {
    const { tenant, entrante, conv, primerContacto, historialPrevio } = p;

    // Descargamos la foto YA (antes de mirar el modo): así el operador la ve en el
    // panel tanto si la atiende el bot como si la atiende una persona.
    let imagenDataUrl: string | undefined;
    try {
      imagenDataUrl = await descargarImagenComoDataUrl(tenant, entrante.imagenId!);
      if (entrante.messageId) {
        await repo
          .actualizarMediaMensaje(tenant.id, conv.id, entrante.messageId, imagenDataUrl, "imagen")
          .catch((e) => console.error("[imagen] no se pudo guardar la media en el mensaje:", e));
      }
    } catch (e) {
      console.error("[imagen] no se pudo descargar la foto:", e);
    }

    if (conv.modo === "humano") {
      await notificarOperador(repo, tenant, conv, "📷 Foto recibida.").catch((e) =>
        console.error("[imagen] notificarOperador:", e),
      );
      return;
    }

    if (!imagenDataUrl) {
      // No pudimos bajar la foto: no dejamos al cliente en silencio ni al bot "adivinar" sin verla.
      await enviarTexto(
        tenant,
        entrante.clienteWa,
        "¡Hola! 🙂 Recibí tu foto pero tuve un problema para verla. ¿Podés volver a mandarla o contarme por texto en qué te ayudo?",
      ).catch(() => {});
      await notificarOperador(repo, tenant, conv, "📷 Foto recibida — no se pudo procesar.").catch(() => {});
      return;
    }

    try {
      const { respuesta, fueraDeAlcance, escalar, motivo, interactivo } = await correrAgente(
        { tenant, repo, clienteWa: entrante.clienteWa },
        entrante.imagenCaption?.trim() || "El cliente mandó esta foto sin comentario. Mirala y ayudalo.",
        historialPrevio,
        imagenDataUrl,
      );

      const modoActual = await repo.obtenerModo(tenant.id, conv.id);
      if (modoActual === "humano") {
        console.log(`[imagen] respuesta descartada: un humano tomó ${entrante.clienteWa} durante el proceso`);
        return;
      }

      if (escalar) {
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        let salida = MENSAJE_ESCALADA;
        if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
        await enviarTexto(tenant, entrante.clienteWa, salida);
        if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: MENSAJE_ESCALADA, creadoEn: new Date().toISOString() });
        await notificarOperador(
          repo,
          tenant,
          conv,
          motivo ? `🙋 El bot pasó este caso (foto): ${motivo}` : "📷 Foto recibida.",
        );
        await repo.registrarCalidad({
          tenantId: tenant.id,
          clienteWa: entrante.clienteWa,
          tipo: "fuera_de_alcance",
          detalle: motivo ? `escalado: ${motivo}` : "escalado a humano (foto)",
        });
        return;
      }

      let salida = respuesta;
      if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;
      await enviarRespuestaBot(tenant, entrante.clienteWa, salida, interactivo);
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: respuesta, creadoEn: new Date().toISOString() });
      console.log(`[imagen→saliente] → ${entrante.clienteWa}: "${respuesta.slice(0, 80)}"`);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
      });
    } catch (e) {
      console.error("[imagen] error procesando:", e);
      await repo
        .registrarCalidad({ tenantId: tenant.id, clienteWa: entrante.clienteWa, tipo: "error", detalle: String(e) })
        .catch(() => {});
      await enviarTexto(
        tenant,
        entrante.clienteWa,
        "Disculpá, tuvimos un problemita viendo tu foto. Probá de nuevo en un momento 🙏",
      ).catch(() => {});
      await notificarOperador(repo, tenant, conv, "⚠️ El bot no pudo responder a una foto recibida.").catch(() => {});
    }
    return;
  }

  if (p.clase === "audio") {
    const { tenant, entrante, conv, primerContacto, historialPrevio } = p;

    if (conv.modo === "humano") {
      await notificarOperador(repo, tenant, conv, "🎤 Nota de voz recibida.").catch((e) =>
        console.error("[audio] notificarOperador:", e),
      );
      return;
    }

    let textoTranscrito: string;
    try {
      textoTranscrito = await transcribirAudio(tenant, entrante.audioId!);
      console.log(`[audio] ${entrante.clienteWa}: "${textoTranscrito.slice(0, 80)}"`);
    } catch (e) {
      console.error("[audio] transcripción fallida:", e);
      await enviarTexto(
        tenant,
        entrante.clienteWa,
        "🎤 Recibí tu nota de voz, pero tuve problemas para escucharla. ¿Podés contarme por texto en qué te ayudo?",
      ).catch(() => {});
      await notificarOperador(repo, tenant, conv, "🎤 Nota de voz recibida — transcripción falló.").catch(() => {});
      return;
    }

    // Escotilla de salida: si el audio pide hablar con una persona, escalamos.
    if (/\bagente\b|\bhumano\b|\bpersona\b/i.test(textoTranscrito)) {
      try {
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        await enviarTexto(
          tenant,
          entrante.clienteWa,
          "¡Listo! Te paso con una persona del equipo. En un momento te responden por acá. 🙋",
        );
        await notificarOperador(repo, tenant, conv, `🎤 ${textoTranscrito}`);
        await repo.registrarCalidad({
          tenantId: tenant.id,
          clienteWa: entrante.clienteWa,
          tipo: "fuera_de_alcance",
          detalle: "pidió humano (audio)",
        });
      } catch (e) {
        console.error("[audio/humano] no se pudo completar el traspaso:", e);
      }
      return;
    }

    try {
      const { respuesta, fueraDeAlcance, escalar, motivo, interactivo } = await correrAgente(
        { tenant, repo, clienteWa: entrante.clienteWa },
        textoTranscrito,
        historialPrevio,
      );

      const modoActual = await repo.obtenerModo(tenant.id, conv.id);
      if (modoActual === "humano") {
        console.log(`[audio] respuesta descartada: un humano tomó ${entrante.clienteWa} durante el proceso`);
        return;
      }

      if (escalar) {
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        let salida = MENSAJE_ESCALADA;
        if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
        await enviarTexto(tenant, entrante.clienteWa, salida);
        if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: MENSAJE_ESCALADA, creadoEn: new Date().toISOString() });
        await notificarOperador(
          repo,
          tenant,
          conv,
          motivo ? `🙋 El bot pasó este caso: ${motivo}` : `🎤 ${textoTranscrito}`,
        );
        await repo.registrarCalidad({
          tenantId: tenant.id,
          clienteWa: entrante.clienteWa,
          tipo: "fuera_de_alcance",
          detalle: motivo ? `escalado: ${motivo}` : "escalado a humano",
        });
        return;
      }

      let salida = respuesta;
      if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;
      await enviarRespuestaBot(tenant, entrante.clienteWa, salida, interactivo);
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: respuesta, creadoEn: new Date().toISOString() });
      console.log(`[audio→saliente] → ${entrante.clienteWa}: "${respuesta.slice(0, 80)}"`);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
      });
    } catch (e) {
      console.error("[audio] error procesando:", e);
      await repo
        .registrarCalidad({ tenantId: tenant.id, clienteWa: entrante.clienteWa, tipo: "error", detalle: String(e) })
        .catch(() => {});
      await enviarTexto(
        tenant,
        entrante.clienteWa,
        "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏",
      ).catch(() => {});
      await notificarOperador(
        repo,
        tenant,
        conv,
        `⚠️ El bot no pudo responder a la nota de voz: "${textoTranscrito.slice(0, 60)}".`,
      ).catch(() => {});
    }
    return;
  }

  const { tenant, entrante, conv, primerContacto, historialPrevio } = p;

  // CONFIRMACIÓN DE CITA (C1.3): el cliente tocó "Confirmo ✅" en el recordatorio.
  // Es una acción directa (no pasa por el agente ni por la ventana de modo humano):
  // marcamos la cita como confirmada y damos un acuse corto. La cita se identifica
  // por el citaId que viajó en el botón que nosotros enviamos.
  const citaAConfirmar = esConfirmacionCita(entrante.interactiveId);
  if (citaAConfirmar) {
    try {
      const confirmada = await repo.confirmarCita(tenant.id, citaAConfirmar);
      const ack = confirmada
        ? "¡Gracias por confirmar tu cita! ✅ Te esperamos. 🚗"
        : "¡Gracias! Si necesitás algo más, escribinos por acá. 🙂";
      await enviarTexto(tenant, entrante.clienteWa, ack);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
      console.log(`[confirmacion] cita ${citaAConfirmar} ${confirmada ? "confirmada" : "no encontrada"} (${entrante.clienteWa})`);
    } catch (e) {
      console.error(`[confirmacion] no se pudo confirmar la cita ${citaAConfirmar}:`, e);
    }
    return;
  }

  // SEGUIMIENTO POST-SERVICIO (C3.1 + Carril D 1.3): el cliente tocó un botón del
  // mensaje que manda el scheduler unas horas después de la cita. Acción directa (no
  // pasa por el agente ni por la ventana de modo humano): "positivo" (Todo bien/
  // Excelente) pide la reseña de Google; "neutral" (Bien, solo existe en el flujo
  // Pro de 3 botones) agradece SIN pedirla; "negativo" (mal) escala a un humano antes
  // de que se convierta en reseña negativa. registrarRespuestaSeguimiento es no-op si
  // el tenant es Básico (nunca se creó la fila de tracking al enviar).
  const postServicio = respuestaPostServicio(entrante.interactiveId);
  if (postServicio) {
    const { citaId, sentimiento } = postServicio;
    try {
      if (sentimiento === "positivo") {
        const ack = tenant.linkResenas
          ? `¡Qué alegría! 🙌 Si tenés un minuto, nos ayudaría muchísimo que dejaras una reseña en Google: ${tenant.linkResenas}`
          : "¡Qué alegría! 🙌 Gracias por la confianza.";
        await enviarTexto(tenant, entrante.clienteWa, ack);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
      } else if (sentimiento === "neutral") {
        const ack = "¡Qué bueno! 🙌 Gracias por la confianza.";
        await enviarTexto(tenant, entrante.clienteWa, ack);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
      } else {
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        const ack = "Lamentamos escuchar eso 🙏 Ya le avisamos a una persona del equipo para que te contacte.";
        await enviarTexto(tenant, entrante.clienteWa, ack);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
        await notificarOperador(
          repo,
          tenant,
          conv,
          `⚠️ Cliente insatisfecho tras el servicio (cita ${citaId}) — contactalo antes de que quede una reseña negativa.`,
        );
      }
      await repo.registrarRespuestaSeguimiento(tenant.id, citaId, sentimiento, sentimiento === "positivo", entrante.texto);
      console.log(`[post-servicio] cita ${citaId} → ${sentimiento} (${entrante.clienteWa})`);
    } catch (e) {
      console.error(`[post-servicio] no se pudo procesar la respuesta de la cita ${citaId}:`, e);
    }
    return;
  }

  // OPT-OUT DE CAMPAÑAS (C3.2): comando exacto "BAJA" (no una palabra suelta en una
  // frase, para evitar falsos positivos). Es acción directa: no pasa por el agente
  // ni depende del modo (humano/bot) — un cliente puede pedir baja aunque lo esté
  // atendiendo una persona. Detiene SOLO campañas de marketing; los recordatorios y
  // el seguimiento post-servicio siguen llegando (son mensajes de servicio, no
  // marketing, ligados a una cita que el cliente ya agendó).
  if (entrante.texto.trim().toLowerCase() === "baja") {
    try {
      await repo.marcarOptOut(tenant.id, conv.id);
      const ack = "Listo, no vas a recibir más promociones de nuestra parte. Si necesitás algo más, escribinos por acá 🙂";
      await enviarTexto(tenant, entrante.clienteWa, ack);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
      console.log(`[opt-out] ${entrante.clienteWa} pidió baja de campañas`);
    } catch (e) {
      console.error(`[opt-out] no se pudo procesar la baja de ${entrante.clienteWa}:`, e);
    }
    return;
  }

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
    const { respuesta, fueraDeAlcance, escalar, motivo, interactivo } = await correrAgente(
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

    // El bot no pudo resolver (pidió escalar_a_humano o se trabó): pasamos la conversación
    // a una persona y avisamos (push), en vez de mandar una respuesta vaga o genérica.
    if (escalar) {
      await repo.setModoConversacion(tenant.id, conv.id, "humano");
      let salida = MENSAJE_ESCALADA;
      if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
      await enviarTexto(tenant, entrante.clienteWa, salida);
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, {
        rol: "assistant",
        contenido: MENSAJE_ESCALADA,
        creadoEn: new Date().toISOString(),
      });
      await notificarOperador(repo, tenant, conv, motivo ? `🙋 El bot pasó este caso: ${motivo}` : entrante.texto);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: "fuera_de_alcance",
        detalle: motivo ? `escalado: ${motivo}` : "escalado a humano",
      });
      console.log(`[escalado] → ${entrante.clienteWa}: el bot pasó a humano${motivo ? ` (${motivo})` : ""}`);
      return;
    }

    // En el primer contacto, anteponer el aviso de bot (transparencia + opt-in).
    let salida = respuesta;
    if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;

    // Enviar PRIMERO y persistir DESPUÉS: si el envío falla, no queda un mensaje
    // "fantasma" en el historial que el cliente nunca recibió (y el opt-in no se
    // marca, así el aviso se reintenta en el próximo mensaje).
    await enviarRespuestaBot(tenant, entrante.clienteWa, salida, interactivo);
    if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
    await repo.guardarMensaje(tenant.id, conv.id, {
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
