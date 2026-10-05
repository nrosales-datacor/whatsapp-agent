import { hayBaseDeDatos } from "../../config/tenantStore";
import { tenantPuede } from "../../billing/planes";
import {
  cancelarCampania,
  confirmarEnvioCampania,
  crearCampania,
  listarCampanias,
  obtenerCampania,
} from "../../campaigns/campanias";
import { previsualizarSegmentoDetalle, resumenConsentimiento } from "../../campaigns/segmentos";
import { json, leerBody } from "../http";
import { leerSegmentoFiltro, leerSegmentoFiltroDeBody } from "../comun";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas segmentadas (C3.2) y consentimiento de marketing.
// ─────────────────────────────────────────────────────────────────────────────

/** campanias/*. */
export async function manejarRutasCampanias(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, ruta, metodo, tenant, rol } = ctx;
  // ── Campañas segmentadas (ROADMAP C3.2) — solo dueño, requiere base de datos ──
  if (ruta === "campanias" || ruta.startsWith("campanias/")) {
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede gestionar campañas" }), true;
    }
    if (!tenantPuede(tenant, "campanias")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "Las campañas requieren base de datos (no configurada)." }), true;
    }

    if (ruta === "campanias" && metodo === "GET") {
      const campanias = await listarCampanias(tenant.id);
      return json(res, 200, { ok: true, campanias }), true;
    }

    if (ruta === "campanias/segmento/preview" && metodo === "GET") {
      const q = new URL(req.url ?? "/", "http://panel.local").searchParams;
      const filtro = leerSegmentoFiltro(q, tenant);
      if (!filtro) return json(res, 400, { ok: false, error: "Segmento inválido" }), true;
      const { destinatarios, sinConsentimiento, conBaja } = await previsualizarSegmentoDetalle(tenant.id, filtro);
      return json(res, 200, {
        ok: true,
        total: destinatarios.length,
        muestra: destinatarios.slice(0, 20),
        // Califican por el filtro pero NO reciben la campaña (consentimiento obligatorio).
        sinConsentimiento,
        conBaja,
      }), true;
    }

    // Cuántos clientes del negocio dieron permiso de promociones (consentimiento explícito).
    if (ruta === "campanias/consentimiento" && metodo === "GET") {
      const resumen = await resumenConsentimiento(tenant.id);
      return json(res, 200, { ok: true, ...resumen }), true;
    }

    if (ruta === "campanias" && metodo === "POST") {
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;

      const nombre = String(body?.nombre ?? "").trim();
      if (!nombre || nombre.length > 80) {
        return json(res, 400, { ok: false, error: "Nombre inválido (1 a 80 caracteres)" }), true;
      }
      const mensaje = String(body?.mensaje ?? "").trim();
      if (!mensaje || mensaje.length > 300) {
        return json(res, 400, { ok: false, error: "Mensaje inválido (1 a 300 caracteres)" }), true;
      }
      const filtro = leerSegmentoFiltroDeBody(body, tenant);
      if (!filtro) return json(res, 400, { ok: false, error: "Segmento inválido" }), true;

      const campania = await crearCampania(tenant.id, { nombre, mensaje, segmentoTipo: filtro.tipo, segmentoParametros: filtro });
      return json(res, 201, { ok: true, campania }), true;
    }

    // /campanias/{id} y /campanias/{id}/{accion}
    const partes = ruta.split("/");
    const campaniaId = partes[1] ? decodeURIComponent(partes[1]) : null;
    if (!campaniaId) return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;

    if (partes.length === 2 && metodo === "GET") {
      const campania = await obtenerCampania(tenant.id, campaniaId);
      if (!campania) return json(res, 404, { ok: false, error: "Campaña no encontrada" }), true;
      return json(res, 200, { ok: true, campania }), true;
    }

    if (partes.length === 3 && partes[2] === "enviar" && metodo === "POST") {
      if (!tenant.plantillaMarketing) {
        return json(res, 400, {
          ok: false,
          error: "Configurá la plantilla de marketing en \"Mi negocio\" antes de enviar campañas",
        }), true;
      }
      const body = await leerBody(req);
      if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
      const programadaPara = body?.programadaPara ? String(body.programadaPara) : null;
      if (programadaPara && Number.isNaN(new Date(programadaPara).getTime())) {
        return json(res, 400, { ok: false, error: "Fecha de programación inválida" }), true;
      }
      try {
        const campania = await confirmarEnvioCampania(tenant.id, campaniaId, programadaPara);
        return json(res, 200, { ok: true, campania }), true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "NO_ENCONTRADA") return json(res, 404, { ok: false, error: "Campaña no encontrada" }), true;
        if (msg === "YA_ENVIADA") return json(res, 400, { ok: false, error: "Esa campaña ya se envió o está en curso" }), true;
        if (msg === "SIN_DESTINATARIOS") return json(res, 400, { ok: false, error: "El segmento no tiene destinatarios" }), true;
        console.error("[campanias] confirmarEnvioCampania:", e);
        return json(res, 500, { ok: false, error: "No se pudo confirmar el envío." }), true;
      }
    }

    if (partes.length === 3 && partes[2] === "cancelar" && metodo === "POST") {
      const campania = await cancelarCampania(tenant.id, campaniaId);
      if (!campania) return json(res, 404, { ok: false, error: "Campaña no encontrada o ya finalizada" }), true;
      return json(res, 200, { ok: true, campania }), true;
    }

    return json(res, 404, { ok: false, error: "Ruta no encontrada" }), true;
  }
  return false;
}
