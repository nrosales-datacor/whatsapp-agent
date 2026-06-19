import type { Repositorio } from "./types";
import { tenantPorPhoneNumberId } from "./config/tenants";
import { parsearEntrante, enviarTexto } from "./whatsapp/client";
import { correrAgente } from "./agent/runAgent";

// Aviso de transparencia que se manda UNA vez por cliente (cumple opt-in/política).
const AVISO_BOT =
  "👋 ¡Hola! Soy el asistente automatizado de %NOMBRE%. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.";

/**
 * Procesa el cuerpo (ya parseado) de un POST del webhook de WhatsApp.
 * Es idempotente respecto al tenant: si no reconoce el número, ignora.
 */
export async function manejarWebhook(body: unknown, repo: Repositorio): Promise<void> {
  const entrante = parsearEntrante(body);
  if (!entrante) return; // status u otro evento que no nos interesa

  const tenant = tenantPorPhoneNumberId(entrante.phoneNumberId);
  if (!tenant) {
    console.warn("[webhook] mensaje a un phone_number_id sin tenant:", entrante.phoneNumberId);
    return;
  }

  // Por ahora solo manejamos texto.
  if (!entrante.esTexto || !entrante.texto.trim()) {
    await enviarTexto(tenant, entrante.clienteWa, "Por ahora solo puedo leer mensajes de texto 🙂");
    return;
  }

  console.log(`[entrante] ${entrante.clienteWa}: "${entrante.texto.slice(0, 80)}"`);

  const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
  const primerContacto = !conv.optInEn;

  // Guardar el mensaje del usuario.
  await repo.guardarMensaje(conv.id, {
    rol: "user",
    contenido: entrante.texto,
    creadoEn: new Date().toISOString(),
  });

  // Escotilla de salida humana: si pide "agente", no responde el bot.
  if (/\bagente\b|\bhumano\b|\bpersona\b/i.test(entrante.texto)) {
    await enviarTexto(
      tenant,
      entrante.clienteWa,
      "¡Claro! En un momento un encargado te atiende por este mismo chat. 🙋",
    );
    await repo.registrarCalidad({
      tenantId: tenant.id,
      clienteWa: entrante.clienteWa,
      tipo: "fuera_de_alcance",
      detalle: "pidió humano",
    });
    return;
  }

  try {
    const { respuesta, fueraDeAlcance } = await correrAgente(
      { tenant, repo, clienteWa: entrante.clienteWa },
      entrante.texto,
      conv.mensajes,
    );

    // En el primer contacto, anteponer el aviso de bot (transparencia + opt-in).
    let salida = respuesta;
    if (primerContacto) {
      await repo.marcarOptIn(conv.id);
      salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;
    }

    await repo.guardarMensaje(conv.id, {
      rol: "assistant",
      contenido: respuesta,
      creadoEn: new Date().toISOString(),
    });

    await enviarTexto(tenant, entrante.clienteWa, salida);
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
    );
  }
}
