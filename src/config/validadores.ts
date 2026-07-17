import type { Bloqueo, HorarioDia, Service } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Validación server-side de la config de un negocio (horario/servicios/faq/
// bloqueos). Compartida por el alta de negocios (onboarding B3, superadmin) y
// la config self-service del operador (ROADMAP C2.2) — nunca se confía en el
// cliente, ambos caminos revalidan acá.
// ─────────────────────────────────────────────────────────────────────────────

export const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
export const RE_URL_HTTP = /^https?:\/\/.+/i;
export const RE_NOMBRE_PLANTILLA = /^[a-z0-9_]+$/;
export const RE_COLOR_HEX = /^#[0-9a-f]{6}$/i;
// Los Place ID de Google son alfanuméricos con "_"/"-" (ej: "ChIJN1t_tDeuEmsRUsoyG83frY4").
export const RE_GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

export function limpiarLineas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s ?? "").trim()).filter(Boolean);
}

export function validarHorario(v: any): Record<number, HorarioDia> | null {
  const out: Record<number, HorarioDia> = {};
  for (let d = 0; d < 7; d++) {
    const dia = v && typeof v === "object" ? v[d] : undefined;
    if (dia === undefined || dia === null) {
      out[d] = { abre: "06:00", cierra: "18:00" }; // default razonable para días sin especificar
      continue;
    }
    const abre = dia.abre ?? null;
    const cierra = dia.cierra ?? null;
    if (abre === null && cierra === null) {
      out[d] = { abre: null, cierra: null }; // cerrado
      continue;
    }
    if (typeof abre !== "string" || typeof cierra !== "string" || !RE_HORA.test(abre) || !RE_HORA.test(cierra)) {
      return null;
    }
    out[d] = { abre, cierra };
  }
  return out;
}

export type ResultadoServicios = { ok: true; servicios: Service[] } | { ok: false; error: string };

/** Igual que antes pero con mensajes de error puntuales (qué servicio y qué regla falló),
 * para que el operador en "Mi negocio" sepa cuál corregir en vez de un error genérico. */
export function validarServicios(v: unknown): ResultadoServicios {
  if (!Array.isArray(v)) return { ok: false, error: "La lista de servicios debe ser un arreglo" };
  const vistos = new Set<string>();
  const out: Service[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = v[i];
    if (!s || typeof s !== "object") return { ok: false, error: `El servicio #${i + 1} tiene datos inválidos` };
    const r = s as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    const nombre = String(r.nombre ?? "").trim();
    const duracionMin = Number(r.duracionMin);
    const etiqueta = nombre || id || `#${i + 1}`;
    if (!RE_SLUG.test(id) || id.length > 50) {
      return { ok: false, error: `El id del servicio "${etiqueta}" debe usar solo minúsculas, números y guiones (sin espacios, acentos ni mayúsculas)` };
    }
    if (vistos.has(id)) {
      return { ok: false, error: `El id "${id}" está repetido en más de un servicio` };
    }
    if (!nombre || nombre.length > 120) {
      return { ok: false, error: `El servicio "${etiqueta}" necesita un nombre (1 a 120 caracteres)` };
    }
    if (!Number.isInteger(duracionMin) || duracionMin <= 0 || duracionMin > 600) {
      return { ok: false, error: `La duración del servicio "${etiqueta}" debe ser un número entero de minutos (1 a 600)` };
    }
    vistos.add(id);
    const serv: Service = { id, nombre, duracionMin };
    if (r.agendable) serv.agendable = true;
    if (r.precioVariable) serv.precioVariable = true;
    if (r.precio !== undefined && r.precio !== null && r.precio !== "") {
      const p = Number(r.precio);
      if (!Number.isInteger(p) || p < 0) {
        return { ok: false, error: `El precio del servicio "${etiqueta}" debe ser un número entero positivo` };
      }
      serv.precio = p;
    }
    const precioNota = String(r.precioNota ?? "").trim();
    if (precioNota) serv.precioNota = precioNota.slice(0, 200);
    const descripcion = String(r.descripcion ?? "").trim();
    if (descripcion) serv.descripcion = descripcion.slice(0, 500);

    // Upsell inteligente al agendar (Carril D, 1.2): qué add-on ofrecer con este servicio.
    const addonSugeridoId = String(r.addonSugeridoId ?? "").trim();
    if (addonSugeridoId) {
      if (!RE_SLUG.test(addonSugeridoId) || addonSugeridoId.length > 50) {
        return { ok: false, error: `El add-on sugerido de "${etiqueta}" tiene un id inválido` };
      }
      if (addonSugeridoId === id) {
        return { ok: false, error: `El servicio "${etiqueta}" no puede sugerirse a sí mismo como add-on` };
      }
      serv.addonSugeridoId = addonSugeridoId;
    }
    if (r.addonPrecioPromo !== undefined && r.addonPrecioPromo !== null && r.addonPrecioPromo !== "") {
      const ap = Number(r.addonPrecioPromo);
      if (!Number.isInteger(ap) || ap < 0) {
        return { ok: false, error: `El precio promo del add-on de "${etiqueta}" debe ser un número entero positivo` };
      }
      serv.addonPrecioPromo = ap;
    }
    if (r.addonActivo) serv.addonActivo = true;

    out.push(serv);
  }

  // Segunda pasada: un addonSugeridoId debe apuntar a OTRO servicio que exista en la lista
  // (no se puede validar en la primera pasada porque el id sugerido puede aparecer más
  // adelante en el arreglo).
  const idsFinales = new Set(out.map((s) => s.id));
  for (const s of out) {
    if (s.addonSugeridoId && !idsFinales.has(s.addonSugeridoId)) {
      return { ok: false, error: `El add-on sugerido de "${s.nombre}" ("${s.addonSugeridoId}") no existe entre los servicios` };
    }
  }

  return { ok: true, servicios: out };
}

export function validarFaq(v: unknown): { pregunta: string; respuesta: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { pregunta: string; respuesta: string }[] = [];
  for (const f of v) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const pregunta = String(r.pregunta ?? "").trim();
    const respuesta = String(r.respuesta ?? "").trim();
    if (pregunta && respuesta) out.push({ pregunta: pregunta.slice(0, 300), respuesta: respuesta.slice(0, 1000) });
  }
  return out;
}

/**
 * Valida los bloqueos (feriados/vacaciones puntuales, ROADMAP C2.2). Los solapados se
 * permiten tal cual: espaciosDisponibles() solo hace un chequeo de pertenencia por fecha,
 * así que un rango redundante es inofensivo — no vale la pena la complejidad de mergearlos.
 */
export function validarBloqueos(v: unknown): Bloqueo[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length > 50) return null;
  const out: Bloqueo[] = [];
  for (const b of v) {
    if (!b || typeof b !== "object") return null;
    const r = b as Record<string, unknown>;
    const desde = String(r.desde ?? "");
    const hasta = String(r.hasta ?? "");
    if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta) || desde > hasta) return null;
    const bloqueo: Bloqueo = { desde, hasta };
    const motivo = String(r.motivo ?? "").trim();
    if (motivo) bloqueo.motivo = motivo.slice(0, 200);
    out.push(bloqueo);
  }
  return out;
}

/**
 * Valida el link de reseñas de Google (Maps / "Escribir reseña"), usado en el
 * seguimiento post-servicio (ROADMAP C3.1). Vacío = sin configurar (válido: el
 * seguimiento simplemente no pide reseña). Devuelve null si viene algo no vacío
 * pero inválido.
 */
export function validarLinkResenas(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length > 500 || !RE_URL_HTTP.test(s)) return null;
  return s;
}

/**
 * Valida el nombre de la plantilla MARKETING aprobada en Meta para campañas
 * segmentadas (ROADMAP C3.2). Vacío = sin configurar (el dueño no puede enviar
 * campañas todavía). Devuelve null si viene algo no vacío pero inválido (mismo
 * formato de nombre de plantilla que exige WhatsApp Manager: minúsculas, números
 * y guiones bajos — ver GUIA-META.md).
 */
export function validarNombrePlantillaMarketing(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 80 || !RE_NOMBRE_PLANTILLA.test(s)) return null;
  return s;
}

/**
 * Valida el nombre de la plantilla de UTILIDAD aprobada en Meta para reabrir
 * conversaciones fuera de la ventana de 24h (ROADMAP Carril D, 0.3). Vacío = sin
 * configurar (el panel no puede reabrir). Mismo formato que la de marketing.
 */
export function validarNombrePlantillaReapertura(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 80 || !RE_NOMBRE_PLANTILLA.test(s)) return null;
  return s;
}

/**
 * Valida un color de marca en hex "#rrggbb" (white-label, ROADMAP C4.1). Vacío = sin
 * configurar (el panel usa la paleta verde default). Devuelve null si viene algo no
 * vacío pero con un formato distinto.
 */
export function validarColorHex(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!RE_COLOR_HEX.test(s)) return null;
  return s.toLowerCase();
}

/**
 * Valida la URL del logo del negocio (white-label, ROADMAP C4.1). Vacío = sin
 * configurar (el panel muestra las iniciales del nombre). Mismo criterio que
 * validarLinkResenas: solo URLs http(s) (no hay upload de archivos en el repo).
 */
export function validarLogoUrl(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length > 500 || !RE_URL_HTTP.test(s)) return null;
  return s;
}

/**
 * Valida las horas de espera antes del primer toque del rescate de cotizaciones
 * (Carril D, 1.1). 1 a 72 horas (más de 3 días ya no tiene sentido como "rescate").
 */
export function validarRescateHoras(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 72) return null;
  return n;
}

/** Valida los textos editables de los toques del rescate. Vacío = usa el texto por defecto. */
export function validarTextoRescate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length > 300) return null;
  return s;
}

/**
 * Valida el nombre de la plantilla de Meta del segundo toque del rescate (fuera de
 * la ventana de 24h). Vacío = sin configurar (el rescate se detiene después del
 * primer toque). Mismo formato que las demás plantillas (validarNombrePlantillaMarketing).
 */
export function validarNombrePlantillaRescate(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 80 || !RE_NOMBRE_PLANTILLA.test(s)) return null;
  return s;
}

/**
 * Valida el Place ID de Google del negocio (Carril D, 1.3-c: motor de reseñas
 * completo, job diario de Places API). Vacío = sin configurar (el job no corre para
 * este tenant). Devuelve null si viene algo no vacío pero con un formato inválido.
 */
export function validarGooglePlaceId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!RE_GOOGLE_PLACE_ID.test(s)) return null;
  return s;
}
