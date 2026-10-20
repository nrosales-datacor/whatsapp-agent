import { actorUsuario } from "../../config/auditoria";
import { borrarDatosCliente, normalizarTelefono } from "../../config/supresionCliente";
import { enviarPlantilla, enviarTexto } from "../../whatsapp/client";
import type { EstadoConversacion } from "../../types";
import { pedirConsentimientoMarketing } from "../../campaigns/consentimiento";
import { hoyEnTz } from "../../booking/gestionCitas";
import { json, leerBody } from "../http";
import { responderErrorSupresion, resumenSupresion } from "../comun";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Bandeja: listado paginado, métricas y acciones sobre una conversación.
// ─────────────────────────────────────────────────────────────────────────────

/** conversaciones, metricas y conversaciones/:id/:accion. */
export async function manejarRutasBandeja(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, repo, ruta, metodo, tenant, rol, usuarioId } = ctx;
  if (ruta === "conversaciones" && metodo === "GET") {
    // Paginado: `limite` (default 100, máx 500) y `buscar` (teléfono o nombre, en TODAS las
    // conversaciones, no solo las cargadas). Se pide una de más para saber si hay más.
    const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
    const pedido = Number(q.get("limite") ?? 100);
    const limite = Number.isInteger(pedido) ? Math.min(Math.max(pedido, 1), 500) : 100;
    const buscar = (q.get("buscar") ?? "").trim().slice(0, 60) || undefined;
    const filas = await repo.listarConversaciones(tenant.id, { limite: limite + 1, buscar, hoy: hoyEnTz(tenant.timezone) });
    json(res, 200, { ok: true, conversaciones: filas.slice(0, limite), hayMas: filas.length > limite });
    return true;
  }

  if (ruta === "metricas" && metodo === "GET") {
    const m = await repo.metricas(tenant.id);
    const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
    m.serviciosTop = m.serviciosTop.map((s) => ({ ...s, nombre: nombreDe(s.servicioId) }));
    json(res, 200, { ok: true, metricas: m });
    return true;
  }

  // /conversaciones/{id} y /conversaciones/{id}/{accion}
  const partes = ruta.split("/");
  if (partes[0] === "conversaciones" && partes[1]) {
    const convId = decodeURIComponent(partes[1]);
    const accion = partes[2];

    if (!accion && metodo === "GET") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId, { hoy: hoyEnTz(tenant.timezone) });
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      // Marcar leídas no debe bloquear la respuesta: corre en segundo plano.
      void repo.marcarLeidas(tenant.id, conv.id).catch((e) => console.error("[panel] marcarLeidas:", e));
      return json(res, 200, { ok: true, conversacion: conv }), true;
    }

    if (accion === "responder" && metodo === "POST") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const t = String(body.texto ?? "").trim();
      if (!t) return json(res, 400, { ok: false, error: "Mensaje vacío" }), true;
      if (t.length > 4096) return json(res, 400, { ok: false, error: "El mensaje supera el límite de WhatsApp (4096)" }), true;

      // Ventana de 24h (Carril D, 0.3): fuera de ventana Meta rechaza el texto libre —
      // se corta acá con un error claro en vez de dejar que falle en enviarTexto.
      if (!conv.ventanaAbierta) {
        return json(res, 409, {
          ok: false,
          error: "ventana_cerrada",
          ventanaCierraEn: conv.ventanaCierraEn,
        }), true;
      }

      try {
        await enviarTexto(tenant, conv.clienteWa, t);
      } catch (e) {
        // El detalle (respuesta cruda de Meta, tokens, hosts) solo va al log del server.
        console.error("[panel] enviarTexto falló:", e);
        return json(res, 502, { ok: false, error: "No se pudo enviar el mensaje" }), true;
      }
      // Al responder un humano, la conversación queda en modo humano.
      if (conv.modo !== "humano") await repo.setModoConversacion(tenant.id, conv.id, "humano");
      await repo.guardarMensaje(tenant.id, conv.id, {
        rol: "assistant",
        contenido: t,
        creadoEn: new Date().toISOString(),
        porHumano: true,
      });
      await repo.marcarLeidas(tenant.id, conv.id);
      return json(res, 200, { ok: true }), true;
    }

    // Reabrir conversación fuera de la ventana de 24h (Carril D, 0.3): manda la
    // plantilla de UTILIDAD configurada en "Mi negocio" — el cliente responde y la
    // ventana vuelve a abrirse (mismo mecanismo que un mensaje entrante cualquiera).
    if (accion === "reabrir" && metodo === "POST") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      if (conv.ventanaAbierta) {
        return json(res, 400, { ok: false, error: "La ventana ya está abierta, no hace falta reabrir" }), true;
      }
      if (!tenant.plantillaReapertura) {
        return json(res, 400, {
          ok: false,
          error: "Configurá la plantilla de reapertura en \"Mi negocio\" antes de reabrir conversaciones",
        }), true;
      }
      try {
        await enviarPlantilla(tenant, conv.clienteWa, tenant.plantillaReapertura, "es", [], "utilidad");
      } catch (e) {
        console.error("[panel] enviarPlantilla (reabrir) falló:", e);
        return json(res, 502, { ok: false, error: "No se pudo enviar la plantilla de reapertura" }), true;
      }
      await repo.guardarMensaje(tenant.id, conv.id, {
        rol: "assistant",
        contenido: "📩 Plantilla de reapertura enviada (conversación fuera de la ventana de 24h).",
        creadoEn: new Date().toISOString(),
        porHumano: true,
      });
      return json(res, 200, { ok: true }), true;
    }

    // Consentimiento de marketing: el negocio le pide al cliente, con botones Sí/No,
    // permiso para mandarle promociones (campaigns/consentimiento.ts). Requiere la
    // ventana de 24h abierta (es un mensaje interactivo, no una plantilla).
    if (accion === "pedir-consentimiento" && metodo === "POST") {
      const conv = await repo.obtenerConversacionPorId(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      if (!conv.ventanaAbierta) {
        return json(res, 409, { ok: false, error: "ventana_cerrada", ventanaCierraEn: conv.ventanaCierraEn }), true;
      }
      let resultado;
      try {
        resultado = await pedirConsentimientoMarketing(tenant, repo, conv, { manual: true });
      } catch (e) {
        console.error("[panel] pedirConsentimientoMarketing falló:", e);
        return json(res, 502, { ok: false, error: "No se pudo enviar el pedido de permiso" }), true;
      }
      const errores: Record<string, [number, string]> = {
        sin_plan: [403, "plan_requerido"],
        baja: [409, "El cliente pidió la baja de promociones: no se le vuelve a preguntar"],
        ya_consiente: [409, "Este cliente ya dio permiso para recibir promociones"],
        ya_preguntado: [409, "Ya se le preguntó hace poco (se puede volver a preguntar a los 30 días)"],
      };
      if (resultado !== "enviado") {
        const [status, error] = errores[resultado];
        return json(res, status, { ok: false, error, ...(resultado === "sin_plan" ? { plan: "pro" } : {}) }), true;
      }
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "modo" && metodo === "POST") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const { modo } = body;
      if (modo !== "bot" && modo !== "humano") return json(res, 400, { ok: false, error: "modo inválido" }), true;
      await repo.setModoConversacion(tenant.id, conv.id, modo);
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "estado" && metodo === "POST") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const estado: EstadoConversacion = body?.estado;
      if (estado !== "abierta" && estado !== "atendida") return json(res, 400, { ok: false, error: "estado inválido" }), true;
      await repo.marcarEstadoConversacion(tenant.id, conv.id, estado);
      return json(res, 200, { ok: true }), true;
    }

    if (accion === "ficha" && metodo === "GET") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const ficha = await repo.fichaCliente(tenant.id, conv.clienteWa);
      if (!ficha) return json(res, 200, { ok: true, ficha: null }), true;
      const nombreDe = (sid: string) => tenant.servicios.find((s) => s.id === sid)?.nombre ?? sid;
      const enriquecida = {
        ...ficha,
        historial: ficha.historial.map((h) => ({ ...h, servicioNombre: nombreDe(h.servicioId) })),
      };
      return json(res, 200, { ok: true, ficha: enriquecida }), true;
    }

    // Borrar TODOS los datos de este cliente (derecho de supresión, Ley 8968): solo el
    // dueño, con confirmación fuerte (repetir el teléfono del cliente). Scopeado por la
    // sesión: `borrarDatosCliente` busca la conversación con tenant.id en el WHERE, así
    // que el id de una conversación de OTRO negocio responde 404 sin tocar nada.
    if (accion === "borrar-cliente" && metodo === "POST") {
      if (rol !== "dueno") {
        return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede borrar los datos de un cliente" }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const confirmar = normalizarTelefono(body?.confirmar);
      if (!confirmar || confirmar !== normalizarTelefono(conv.clienteWa)) {
        return json(res, 400, { ok: false, error: "El número no coincide con el del cliente; no se borró nada." }), true;
      }
      try {
        const r = await borrarDatosCliente({ tenant, conversacionId: conv.id, actor: actorUsuario(usuarioId) });
        return json(res, 200, { ok: true, ...resumenSupresion(r) }), true;
      } catch (e) {
        return responderErrorSupresion(res, e), true;
      }
    }

    if (accion === "notas" && metodo === "POST") {
      const conv = await repo.obtenerEstadoConversacion(tenant.id, convId);
      if (!conv) return json(res, 404, { ok: false, error: "No existe" }), true;
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const notas = String(body.notas ?? "");
      if (notas.length > 4000) return json(res, 400, { ok: false, error: "Las notas son demasiado largas (máx 4000)" }), true;
      await repo.guardarNotas(tenant.id, conv.id, notas);
      return json(res, 200, { ok: true }), true;
    }
  }
  return false;
}
