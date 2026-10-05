import {
  actualizarConfigTenant,
  hayBaseDeDatos,
  listarHistorialConfigTenant,
  recargar,
  restaurarVersionConfigTenant,
} from "../../config/tenantStore";
import {
  limpiarLineas,
  limpiarTexto,
  validarBloqueos,
  validarColorHex,
  validarEmpleados,
  validarFaq,
  validarGoogleCalendarId,
  validarGooglePlaceId,
  validarHorario,
  validarLinkResenas,
  validarLogoUrl,
  validarMensajeTopeExcedido,
  validarNombrePlantillaMarketing,
  validarNombrePlantillaReapertura,
  validarNombrePlantillaRecordatorio,
  validarNombrePlantillaRescate,
  validarPlantillaIdioma,
  validarRegistro,
  validarRescateHoras,
  validarSecciones,
  validarServicios,
  validarTamanoKb,
  validarTextoRescate,
} from "../../config/validadores";
import type { KnowledgeBase } from "../../types";
import { tenantPuede } from "../../billing/planes";
import { hoyEnTz } from "../../booking/gestionCitas";
import { json, leerBody } from "../http";
import type { ContextoOperador } from "./contexto";

// ─────────────────────────────────────────────────────────────────────────────
// "Mi negocio": config self-service (C2.2) e historial versionado (F15).
// ─────────────────────────────────────────────────────────────────────────────

/** config, config/historial y config/restaurar. */
export async function manejarRutasConfig(ctx: ContextoOperador): Promise<boolean> {
  const { req, res, repo, ruta, metodo, tenant, rol, usuarioId } = ctx;
  // ── Config self-service del negocio (ROADMAP C2.2) ──
  if (ruta === "config" && metodo === "GET") {
    json(res, 200, {
      ok: true,
      horario: tenant.horario,
      servicios: tenant.servicios, // catálogo completo, sin filtrar por agendable (a diferencia de "me")
      kb: tenant.kb,
      bloqueos: tenant.bloqueos,
      empleados: tenant.empleados ?? [],
      linkResenas: tenant.linkResenas ?? "",
      plantillaMarketing: tenant.plantillaMarketing ?? "",
      plantillaReapertura: tenant.plantillaReapertura ?? "",
      plantillaRecordatorio: tenant.plantillaRecordatorio ?? "",
      plantillaIdioma: tenant.plantillaIdioma ?? "",
      colorAcento: tenant.colorAcento ?? "",
      colorHeader: tenant.colorHeader ?? "",
      logoUrl: tenant.logoUrl ?? "",
      rescateActivo: tenant.rescateActivo ?? false,
      rescateHorasEspera: tenant.rescateHorasEspera ?? 3,
      rescateToque1Texto: tenant.rescateToque1Texto ?? "",
      rescateToque2Texto: tenant.rescateToque2Texto ?? "",
      rescatePlantilla: tenant.rescatePlantilla ?? "",
      googlePlaceId: tenant.googlePlaceId ?? "",
      googleCalendarId: tenant.googleCalendarId ?? "",
      // El dueño necesita saber a qué cuenta compartirle su calendario (auditoría BLOQ-05).
      calendarioServiceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "",
      tipoNegocio: tenant.tipoNegocio ?? "",
      pais: tenant.pais ?? "",
      formasPago: tenant.formasPago ?? "",
      registro: tenant.registro ?? "",
      tono: tenant.tono ?? "",
      instrucciones: tenant.instrucciones ?? "",
      mensajeTopeExcedido: tenant.mensajeTopeExcedido ?? "",
    });
    return true;
  }

  if (ruta === "config" && metodo === "POST") {
    // Editar "Mi negocio" es solo del dueño (C2.3) — igual que gestionar usuarios. No
    // alcanza con esconder la pestaña en el frontend: sin este check, un operador podría
    // mandar el POST a mano y editarla igual.
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede editar la configuración" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "La configuración requiere base de datos (no configurada)." }), true;
    }
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;

    const horario = validarHorario(body?.horario);
    if (!horario) return json(res, 400, { ok: false, error: "Horario inválido (usá formato HH:mm, con la hora de cierre después de la de apertura, o vacío para día cerrado)" }), true;

    const resServicios = validarServicios(body?.servicios ?? []);
    if (!resServicios.ok) return json(res, 400, { ok: false, error: resServicios.error }), true;
    const servicios = resServicios.servicios;

    // Upsell inteligente al agendar (Carril D, 1.2) es Pro, igual que campañas/white-label:
    // un Básico no puede activar un add-on aunque mande el POST directo.
    if (servicios.some((s) => s.addonActivo) && !tenantPuede(tenant, "upsell")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const bloqueos = validarBloqueos(body?.bloqueos ?? []);
    if (!bloqueos) return json(res, 400, { ok: false, error: "Hay un bloqueo inválido (fechas YYYY-MM-DD, desde ≤ hasta)" }), true;

    // Equipo que atiende (ALTO-07). Se valida contra los servicios de ESTE mismo POST,
    // no contra los guardados: el dueño puede renombrar un servicio y reasignarlo en la
    // misma pantalla, y ahí el catálogo viejo ya no es la referencia correcta.
    const resEmpleados = validarEmpleados(body?.empleados, new Set(servicios.map((s) => s.id)));
    if (!resEmpleados.ok) return json(res, 400, { ok: false, error: resEmpleados.error }), true;
    const empleados = resEmpleados.empleados;

    // Guard de borrado: un empleado con citas NO se puede eliminar de la lista, porque
    // wa_citas.empleado_id lo referencia y el histórico quedaría apuntando a la nada.
    // Desactivarlo (activo:false) sí se permite siempre — es la vía normal para alguien
    // que se fue. Solo se mira el futuro: las citas pasadas conservan el nombre igual.
    const idsNuevos = new Set(empleados.map((e) => e.id));
    const eliminados = (tenant.empleados ?? []).filter((e) => !idsNuevos.has(e.id));
    if (eliminados.length > 0) {
      const hoy = hoyEnTz(tenant.timezone);
      const futuras = await repo.citasEnRango(tenant.id, hoy, "9999-12-31");
      const conCitas = eliminados.filter((e) =>
        futuras.some((c) => c.empleadoId === e.id && c.estado === "agendada"),
      );
      if (conCitas.length > 0) {
        return (
          json(res, 409, {
            ok: false,
            error: `No se puede eliminar a ${conCitas
              .map((e) => e.nombre)
              .join(", ")}: tiene citas agendadas. Desactivalo en vez de borrarlo, o reasigná sus citas primero.`,
          }),
          true
        );
      }
    }

    const linkResenas = validarLinkResenas(body?.linkResenas);
    if (linkResenas === null) return json(res, 400, { ok: false, error: "Link de reseñas inválido (debe ser una URL http o https)" }), true;

    const plantillaMarketing = validarNombrePlantillaMarketing(body?.plantillaMarketing);
    if (plantillaMarketing === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }

    const plantillaReapertura = validarNombrePlantillaReapertura(body?.plantillaReapertura);
    if (plantillaReapertura === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }

    // Plantilla de recordatorio de cita por tenant (E8/BLOQ-06): antes era la env global
    // WHATSAPP_TEMPLATE_RECORDATORIO, que solo alcanza para un cliente a la vez.
    const plantillaRecordatorio = validarNombrePlantillaRecordatorio(body?.plantillaRecordatorio);
    if (plantillaRecordatorio === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }
    const plantillaIdioma = validarPlantillaIdioma(body?.plantillaIdioma);
    if (plantillaIdioma === null) {
      return json(res, 400, { ok: false, error: "Idioma de plantilla inválido (ej: es, es_MX, en_US)" }), true;
    }

    const colorAcento = validarColorHex(body?.colorAcento);
    if (colorAcento === null) return json(res, 400, { ok: false, error: "Color de acento inválido (formato #rrggbb)" }), true;

    const colorHeader = validarColorHex(body?.colorHeader);
    if (colorHeader === null) return json(res, 400, { ok: false, error: "Color de encabezado inválido (formato #rrggbb)" }), true;

    const logoUrl = validarLogoUrl(body?.logoUrl);
    if (logoUrl === null) return json(res, 400, { ok: false, error: "URL del logo inválida (debe ser una URL https)" }), true;

    // White-label (C4.1) es Pro (Carril D, 0.1): un Básico no puede setear marca aunque
    // mande el POST directo, aunque sí puede guardar el resto de "Mi negocio" sin tocarla.
    if ((colorAcento || colorHeader || logoUrl) && !tenantPuede(tenant, "whiteLabel")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const rescateActivo = !!body?.rescateActivo;
    const rescateHorasEspera = validarRescateHoras(body?.rescateHorasEspera ?? 3);
    if (rescateHorasEspera === null) {
      return json(res, 400, { ok: false, error: "Horas de espera del rescate inválidas (1 a 72)" }), true;
    }
    const rescateToque1Texto = validarTextoRescate(body?.rescateToque1Texto);
    if (rescateToque1Texto === null) return json(res, 400, { ok: false, error: "Texto del primer toque inválido (máx. 300 caracteres)" }), true;
    const rescateToque2Texto = validarTextoRescate(body?.rescateToque2Texto);
    if (rescateToque2Texto === null) return json(res, 400, { ok: false, error: "Texto del segundo toque inválido (máx. 300 caracteres)" }), true;
    const rescatePlantilla = validarNombrePlantillaRescate(body?.rescatePlantilla);
    if (rescatePlantilla === null) {
      return json(res, 400, { ok: false, error: "Nombre de plantilla inválido (minúsculas, números y guiones bajos)" }), true;
    }

    // Mensaje configurable al llegar al tope mensual (F10). Vacío = usa el default.
    // Ausente en el body = se conserva el actual: "Mi negocio" no tiene ese campo, y su
    // guardado (que reemplaza toda la config) lo borraba sin que el dueño lo tocara.
    const mensajeTopeExcedido = validarMensajeTopeExcedido(
      body?.mensajeTopeExcedido === undefined ? tenant.mensajeTopeExcedido : body.mensajeTopeExcedido,
    );
    if (mensajeTopeExcedido === null) {
      return json(res, 400, { ok: false, error: "Mensaje de tope excedido inválido (máx. 300 caracteres)" }), true;
    }
    // Rescate de cotizaciones (Carril D, 1.1) es Pro, igual que campañas/white-label.
    if (rescateActivo && !tenantPuede(tenant, "rescateCotizaciones")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    const googlePlaceId = validarGooglePlaceId(body?.googlePlaceId);
    if (googlePlaceId === null) return json(res, 400, { ok: false, error: "Place ID de Google inválido" }), true;
    // Motor de reseñas completo (Carril D, 1.3) es Pro: un Básico no puede activar el
    // job de reputación aunque mande el POST directo.
    if (googlePlaceId && !tenantPuede(tenant, "resenasPro")) {
      return json(res, 403, { ok: false, error: "plan_requerido", plan: "pro" }), true;
    }

    // Google Calendar del negocio (auditoría BLOQ-05). Sin gating por plan: la agenda
    // es parte del producto Básico, y el calendario propio es lo que evita que las citas
    // de un negocio terminen en el calendario de otro.
    const googleCalendarId = validarGoogleCalendarId(body?.googleCalendarId);
    if (googleCalendarId === null) {
      return json(res, 400, { ok: false, error: "ID de Google Calendar inválido (tiene forma de correo, ej: negocio@gmail.com)" }), true;
    }

    const kb: KnowledgeBase = {
      faq: validarFaq(body?.kb?.faq),
      datos: limpiarLineas(body?.kb?.datos),
      politicas: limpiarLineas(body?.kb?.politicas),
      secciones: validarSecciones(body?.kb?.secciones),
    };
    // Tope de tamaño de la KB (ALTO-16 / F13 — PLAN-ESCALA-MULTITENANT.md): un catálogo
    // gigante encarece CADA llamada al LLM (hasta ~70.000 tokens/mensaje con los 4 pasos
    // de tool-calling, ver AUDIT.md § ALTO-16). Mensaje con el tamaño real y el límite,
    // para que el dueño sepa qué recortar en vez de un 400 genérico.
    const errorTamanoKb = validarTamanoKb(kb);
    if (errorTamanoKb) return json(res, 400, { ok: false, error: errorTamanoKb }), true;

    // Perfil del negocio (B7, motor multi-mercado): textos libres acotados + registro validado.
    const tipoNegocio = limpiarTexto(body?.tipoNegocio, 120);
    const pais = limpiarTexto(body?.pais, 60);
    const formasPago = limpiarTexto(body?.formasPago, 300);
    const registro = validarRegistro(body?.registro);
    const tono = limpiarTexto(body?.tono, 120);
    const instrucciones = limpiarTexto(body?.instrucciones, 4000);

    try {
      await actualizarConfigTenant(tenant.id, {
        horario,
        servicios,
        kb,
        bloqueos,
        empleados,
        linkResenas: linkResenas || null,
        plantillaMarketing: plantillaMarketing || null,
        plantillaReapertura: plantillaReapertura || null,
        plantillaRecordatorio: plantillaRecordatorio || null,
        plantillaIdioma: plantillaIdioma || null,
        colorAcento: colorAcento || null,
        colorHeader: colorHeader || null,
        logoUrl: logoUrl || null,
        rescateActivo,
        rescateHorasEspera,
        rescateToque1Texto: rescateToque1Texto || null,
        rescateToque2Texto: rescateToque2Texto || null,
        rescatePlantilla: rescatePlantilla || null,
        googlePlaceId: googlePlaceId || null,
        googleCalendarId: googleCalendarId || null,
        tipoNegocio: tipoNegocio || null,
        pais: pais || null,
        formasPago: formasPago || null,
        registro: registro || null,
        tono: tono || null,
        instrucciones: instrucciones || null,
        mensajeTopeExcedido: mensajeTopeExcedido || null,
      // F15: quién hizo el cambio, para el historial versionado (misma transacción
      // que el UPDATE, ver actualizarConfigTenant).
      }, usuarioId);
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") {
        return json(res, 503, { ok: false, error: "La configuración requiere base de datos." }), true;
      }
      console.error("[config] actualizarConfigTenant:", e);
      return json(res, 500, { ok: false, error: "No se pudo guardar la configuración." }), true;
    }
    await recargar(); // el cambio queda visible sin esperar el refresco periódico
    return json(res, 200, { ok: true }), true;
  }

  // ── Historial versionado de "Mi negocio" (ROADMAP F15) ──
  // Mismo gate que "config": solo el dueño ve/restaura el historial de SU negocio. El
  // cálculo de diff legible entre versiones es trabajo de frontend, pendiente: acá
  // alcanza con devolver los snapshots crudos en orden.
  if (ruta === "config/historial" && metodo === "GET") {
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede ver el historial de configuración" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "El historial requiere base de datos (no configurada)." }), true;
    }
    try {
      // Más reciente primero: es el orden natural para mostrar "última versión" arriba.
      const historial = await listarHistorialConfigTenant(tenant.id);
      return json(res, 200, { ok: true, historial }), true;
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") {
        return json(res, 503, { ok: false, error: "El historial requiere base de datos." }), true;
      }
      console.error("[config/historial] listarHistorialConfigTenant:", e);
      return json(res, 500, { ok: false, error: "No se pudo obtener el historial." }), true;
    }
  }

  if (ruta === "config/restaurar" && metodo === "POST") {
    if (rol !== "dueno") {
      return json(res, 403, { ok: false, error: "Solo el dueño del negocio puede restaurar una versión anterior" }), true;
    }
    if (!hayBaseDeDatos()) {
      return json(res, 503, { ok: false, error: "Restaurar requiere base de datos (no configurada)." }), true;
    }
    const body = await leerBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "Cuerpo demasiado grande" }), true;
    const historialId = typeof body?.historialId === "string" ? body.historialId : "";
    if (!historialId) return json(res, 400, { ok: false, error: "Falta historialId" }), true;

    try {
      // Restaurar ES un cambio nuevo (mismo criterio que un revert en git): aplica el
      // snapshot viejo Y crea una versión nueva, sin borrar ni reescribir el historial.
      const restaurado = await restaurarVersionConfigTenant(tenant.id, historialId, usuarioId);
      if (!restaurado) {
        return json(res, 404, { ok: false, error: "Esa versión no existe o no pertenece a este negocio" }), true;
      }
    } catch (e) {
      if (e instanceof Error && e.message === "SIN_DB") {
        return json(res, 503, { ok: false, error: "Restaurar requiere base de datos." }), true;
      }
      console.error("[config/restaurar] restaurarVersionConfigTenant:", e);
      return json(res, 500, { ok: false, error: "No se pudo restaurar la versión." }), true;
    }
    await recargar(); // el cambio queda visible sin esperar el refresco periódico
    return json(res, 200, { ok: true }), true;
  }
  return false;
}
