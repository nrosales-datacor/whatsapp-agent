import type { Bloqueo, Empleado, HorarioDia, KnowledgeBase, SeccionConocimiento, Service } from "../types";

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
// Locale de Meta para el idioma de una plantilla: "es", "es_MX", "en_US"… (código de
// idioma ISO 639-1 en minúsculas + opcionalmente "_" y país ISO 3166-1 en mayúsculas).
export const RE_PLANTILLA_IDIOMA = /^[a-z]{2}(_[A-Z]{2})?$/;
export const RE_COLOR_HEX = /^#[0-9a-f]{6}$/i;
// Los Place ID de Google son alfanuméricos con "_"/"-" (ej: "ChIJN1t_tDeuEmsRUsoyG83frY4").
export const RE_GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
// El ID de un Google Calendar siempre tiene forma de correo: el principal es el gmail
// del negocio y los secundarios terminan en "@group.calendar.google.com".
export const RE_GOOGLE_CALENDAR_ID = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

/** Convierte un texto a slug estable (para el id de una sección de conocimiento). */
function aSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Valida las secciones libres de la base de conocimiento (multi-mercado): cada una
 * con un `titulo` que el dueño elige y sus `items` (uno por línea). Descarta las que
 * no tengan título o queden sin ítems. Deriva un `id` slug del título y desambigua
 * colisiones, así el prompt/UI tienen una key estable. Tope de 12 secciones (defensa
 * contra prompts gigantes; alcanza de sobra para cualquier rubro).
 */
export function validarSecciones(v: unknown): SeccionConocimiento[] {
  if (!Array.isArray(v)) return [];
  const out: SeccionConocimiento[] = [];
  const vistos = new Set<string>();
  for (const s of v) {
    if (out.length >= 12) break;
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const titulo = String(r.titulo ?? "").trim().slice(0, 60);
    const items = limpiarLineas(r.items);
    if (!titulo || items.length === 0) continue;
    const base = aSlug(titulo) || aSlug(String(r.id ?? "")) || "seccion";
    let id = base;
    let n = 2;
    while (vistos.has(id)) id = `${base}-${n++}`;
    vistos.add(id);
    out.push({ id, titulo, items });
  }
  return out;
}

/**
 * Tope de tamaño TOTAL de la base de conocimiento, en caracteres (ALTO-16 / F13 —
 * PLAN-ESCALA-MULTITENANT.md). Sin este freno, un dueño entusiasta puede pegar hasta
 * MAX_BODY (64 KB, el límite del POST del panel, ver router.ts) de texto ≈ 17.000 tokens
 * en CADA llamada al LLM, y con los MAX_PASOS=4 pasos de tool-calling del agente
 * (runAgent.ts) eso son ~70.000 tokens por mensaje del cliente — más de 10× lo normal, y
 * sin que nadie se entere porque no hay enforcement de uso (AUDIT.md § ALTO-16).
 *
 * 12.000 caracteres (~3.200 tokens, con la aproximación de 3,7 caracteres/token de
 * AUDIT.md § 7) es el número que esa misma auditoría propone: generoso para cualquier
 * rubro real, pero ya no alcanza para "pegar el catálogo completo".
 */
export const MAX_KB_CARACTERES = 12_000;

/** Tamaño total (en caracteres) de una KB ya normalizada — la métrica que se compara
 * contra MAX_KB_CARACTERES y la que se le muestra al dueño en el mensaje de error. */
export function tamanoKb(kb: KnowledgeBase): number {
  let total = 0;
  for (const f of kb.faq) total += f.pregunta.length + f.respuesta.length;
  for (const linea of kb.datos) total += linea.length;
  for (const linea of kb.politicas) total += linea.length;
  for (const s of kb.secciones ?? []) {
    total += s.titulo.length;
    for (const item of s.items) total += item.length;
  }
  return total;
}

/**
 * Valida que la KB no supere MAX_KB_CARACTERES. Devuelve null si está OK, o un mensaje
 * de error con cuánto ocupa y cuál es el límite (para que el dueño sepa qué recortar en
 * "Mi negocio" — el pedido explícito de F13, no un 400 genérico).
 */
export function validarTamanoKb(kb: KnowledgeBase): string | null {
  const total = tamanoKb(kb);
  if (total <= MAX_KB_CARACTERES) return null;
  return (
    `La base de conocimiento ocupa ${total.toLocaleString("es-CR")} caracteres; el máximo es ` +
    `${MAX_KB_CARACTERES.toLocaleString("es-CR")}. Recortá textos o secciones y volvé a guardar.`
  );
}

/**
 * Normaliza un kb crudo (venga de la DB o de un cliente) a la forma vigente. Su
 * trabajo CRÍTICO es la migración perezosa: los tenants guardados antes de las
 * "secciones libres" tienen `tarifas`/`parabrisas` (lavacar) y ningún `secciones`;
 * acá se convierten a secciones nombradas para que el prompt no pierda esos datos.
 * Idempotente: si el kb ya tiene `secciones`, se deja tal cual (validado).
 */
export function normalizarKb(kb: unknown): KnowledgeBase {
  const raw = (kb && typeof kb === "object" ? kb : {}) as Record<string, unknown>;
  const secciones = validarSecciones(raw.secciones);
  // Migración legacy: solo si el kb todavía no tiene secciones propias.
  if (secciones.length === 0) {
    const tarifas = limpiarLineas(raw.tarifas);
    const parabrisas = limpiarLineas(raw.parabrisas);
    if (tarifas.length) secciones.push({ id: "precios-de-lavado", titulo: "Precios de lavado", items: tarifas });
    if (parabrisas.length)
      secciones.push({ id: "servicios-de-parabrisas", titulo: "Servicios de parabrisas", items: parabrisas });
  }
  return {
    faq: validarFaq(raw.faq),
    datos: limpiarLineas(raw.datos),
    politicas: limpiarLineas(raw.politicas),
    secciones,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Perfil del negocio (B7, motor multi-mercado): campos que arman el system prompt
// para cualquier rubro. Todos opcionales — vacío = el prompt usa un default o infiere.
// ─────────────────────────────────────────────────────────────────────────────

/** Recorta un texto libre a un máximo de caracteres (trim + slice). "" si viene vacío. */
export function limpiarTexto(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

/** Valida el registro del trato al cliente. Devuelve "" si no es uno de los válidos. */
export function validarRegistro(v: unknown): "vos" | "tu" | "usted" | "" {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "vos" || s === "tu" || s === "usted" ? s : "";
}

// Mapa chico de zonas horarias LATAM → país + registro por defecto. No pretende ser
// exhaustivo: cubre los mercados probables y cae a un neutro ("", "tu") para el resto.
const PAIS_POR_TZ: Record<string, { pais: string; registro: "vos" | "tu" | "usted" }> = {
  "America/Costa_Rica": { pais: "Costa Rica", registro: "vos" },
  "America/Guatemala": { pais: "Guatemala", registro: "vos" },
  "America/Managua": { pais: "Nicaragua", registro: "vos" },
  "America/Tegucigalpa": { pais: "Honduras", registro: "usted" },
  "America/El_Salvador": { pais: "El Salvador", registro: "vos" },
  "America/Panama": { pais: "Panamá", registro: "tu" },
  "America/Mexico_City": { pais: "México", registro: "tu" },
  "America/Bogota": { pais: "Colombia", registro: "usted" },
  "America/Lima": { pais: "Perú", registro: "tu" },
  "America/Santiago": { pais: "Chile", registro: "tu" },
  "America/Guayaquil": { pais: "Ecuador", registro: "tu" },
  "America/Caracas": { pais: "Venezuela", registro: "tu" },
  "America/Montevideo": { pais: "Uruguay", registro: "tu" },
  "America/Asuncion": { pais: "Paraguay", registro: "tu" },
  "America/La_Paz": { pais: "Bolivia", registro: "tu" },
  "America/Santo_Domingo": { pais: "República Dominicana", registro: "tu" },
};

/** Infiere país + registro a partir de la zona horaria del tenant (fallback neutro). */
export function inferirPaisRegistro(timezone: string): { pais: string; registro: "vos" | "tu" | "usted" } {
  if (timezone.startsWith("America/Argentina/")) return { pais: "Argentina", registro: "vos" };
  return PAIS_POR_TZ[timezone] ?? { pais: "", registro: "tu" };
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

export type ResultadoEmpleados = { ok: true; empleados: Empleado[] } | { ok: false; error: string };

/**
 * Valida el equipo que atiende (ALTO-07): personas, bahías, sillones. Mismo estilo de
 * errores puntuales que `validarServicios` — el dueño edita esto desde "Mi negocio" y
 * necesita saber CUÁL fila corregir.
 *
 * `idsServicios` son los ids de servicios ya validados, para rechazar un `serviciosIds`
 * que apunte a un servicio inexistente (el mismo criterio que la segunda pasada de
 * `validarServicios` con los add-ons).
 *
 * ⚠️ REGLA CRÍTICA: si la fila trae un `id` válido se RESPETA tal cual. Las citas ya
 * guardadas lo referencian por `wa_citas.empleado_id`; regenerarlo desde el nombre
 * dejaría huérfano todo el histórico apenas alguien corrija una tilde. El slug solo se
 * deriva del nombre cuando la fila es nueva y no trae id.
 */
export function validarEmpleados(v: unknown, idsServicios: Set<string>): ResultadoEmpleados {
  if (v === undefined || v === null) return { ok: true, empleados: [] };
  if (!Array.isArray(v)) return { ok: false, error: "La lista de quiénes atienden debe ser un arreglo" };
  if (v.length > 50) return { ok: false, error: "Máximo 50 personas o puestos de atención" };

  const out: Empleado[] = [];
  const vistos = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (!e || typeof e !== "object") return { ok: false, error: `La fila #${i + 1} de quiénes atienden tiene datos inválidos` };
    const r = e as Record<string, unknown>;
    const nombre = String(r.nombre ?? "").trim();
    const etiqueta = nombre || `#${i + 1}`;
    if (!nombre || nombre.length > 120) {
      return { ok: false, error: `La fila "${etiqueta}" necesita un nombre (1 a 120 caracteres)` };
    }

    // Id inmutable si ya venía; derivado del nombre solo para filas nuevas.
    const idCrudo = String(r.id ?? "").trim();
    let id: string;
    if (idCrudo) {
      if (!RE_SLUG.test(idCrudo) || idCrudo.length > 50) {
        return { ok: false, error: `El id de "${etiqueta}" debe usar solo minúsculas, números y guiones` };
      }
      id = idCrudo;
    } else {
      const base = aSlug(nombre) || "empleado";
      id = base;
      let n = 2;
      while (vistos.has(id)) id = `${base}-${n++}`;
    }
    if (vistos.has(id)) return { ok: false, error: `El id "${id}" está repetido en más de una fila` };
    vistos.add(id);

    const emp: Empleado = { id, nombre, activo: r.activo !== false };

    // Vacío/ausente = hace todos los servicios agendables. Solo se persiste si el dueño
    // restringió de verdad, para que el default siga siendo "hace de todo".
    if (r.serviciosIds !== undefined && r.serviciosIds !== null) {
      if (!Array.isArray(r.serviciosIds)) {
        return { ok: false, error: `Los servicios de "${etiqueta}" deben ser un arreglo` };
      }
      const ids: string[] = [];
      for (const s of r.serviciosIds) {
        const sid = String(s ?? "").trim();
        if (!sid) continue;
        if (!idsServicios.has(sid)) {
          return { ok: false, error: `"${etiqueta}" tiene asignado un servicio que no existe ("${sid}")` };
        }
        if (!ids.includes(sid)) ids.push(sid);
      }
      if (ids.length > 0) emp.serviciosIds = ids;
    }

    const bloqueos = validarBloqueos(r.bloqueos ?? []);
    if (bloqueos === null) return { ok: false, error: `Los días libres de "${etiqueta}" tienen un rango de fechas inválido` };
    if (bloqueos.length > 0) emp.bloqueos = bloqueos;

    const color = String(r.color ?? "").trim();
    if (color) {
      if (!RE_COLOR_HEX.test(color)) return { ok: false, error: `El color de "${etiqueta}" debe ser un hex tipo #3366ff` };
      emp.color = color.toLowerCase();
    }

    out.push(emp);
  }
  return { ok: true, empleados: out };
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
 * Validación COMPARTIDA del nombre de cualquier plantilla de Meta (marketing,
 * reapertura, rescate, recordatorio — E8/BLOQ-06: todas se aprueban por WABA, por
 * negocio, con el mismo formato). Vacío = sin configurar. Devuelve null si viene algo
 * no vacío pero con un formato distinto al que exige WhatsApp Manager: minúsculas,
 * números y guiones bajos (ver GUIA-META.md).
 */
function validarNombrePlantilla(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 80 || !RE_NOMBRE_PLANTILLA.test(s)) return null;
  return s;
}

/**
 * Valida el nombre de la plantilla MARKETING aprobada en Meta para campañas
 * segmentadas (ROADMAP C3.2). Vacío = sin configurar (el dueño no puede enviar
 * campañas todavía).
 */
export function validarNombrePlantillaMarketing(v: unknown): string | null {
  return validarNombrePlantilla(v);
}

/**
 * Valida el nombre de la plantilla de UTILIDAD aprobada en Meta para reabrir
 * conversaciones fuera de la ventana de 24h (ROADMAP Carril D, 0.3). Vacío = sin
 * configurar (el panel no puede reabrir).
 */
export function validarNombrePlantillaReapertura(v: unknown): string | null {
  return validarNombrePlantilla(v);
}

/**
 * Valida el nombre de la plantilla de recordatorio de cita aprobada en Meta para ESTE
 * negocio (E8/BLOQ-06). Vacío = sin configurar (el recordatorio cae a texto libre con
 * botones, ver src/reminders/scheduler.ts).
 */
export function validarNombrePlantillaRecordatorio(v: unknown): string | null {
  return validarNombrePlantilla(v);
}

/**
 * Valida el idioma (locale de Meta) con el que se aprobó una plantilla — recordatorio,
 * marketing, rescate — (E8/BLOQ-06). Vacío = sin configurar (se usa el default global
 * WHATSAPP_TEMPLATE_IDIOMA/.env o "es"). Formato: "es", "es_MX", "en_US"… A diferencia
 * del nombre de la plantilla, esto NO es un secreto que deba fallar cerrado por tenant:
 * ver la nota en el schema (plantillaIdioma).
 */
export function validarPlantillaIdioma(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!RE_PLANTILLA_IDIOMA.test(s)) return null;
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
 * Valida el mensaje que recibe el cliente final al llegar al tope mensual de
 * conversaciones (F10 — PLAN-ESCALA-MULTITENANT.md). Vacío = usa el default
 * razonable (MENSAJE_TOPE_EXCEDIDO en handleWebhook.ts). Mismo patrón que
 * validarTextoRescate.
 */
export function validarMensajeTopeExcedido(v: unknown): string | null {
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
  return validarNombrePlantilla(v);
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

/**
 * Valida el ID del Google Calendar del negocio (auditoría BLOQ-05: el calendario
 * pasó de env global a columna por tenant). Vacío = sin configurar (no se sincroniza
 * nada con Calendar para este negocio). Devuelve null si el formato es inválido.
 *
 * Siempre tiene forma de correo: el calendario principal es el propio gmail
 * ("negocio@gmail.com") y los secundarios son "…@group.calendar.google.com".
 * Se rechaza a propósito el alias "primary" de Google: apuntaría al calendario de
 * NUESTRA service account, es decir el mismo para todos los tenants — justo la fuga
 * entre negocios que este cambio elimina.
 */
export function validarGoogleCalendarId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length > 300 || !RE_GOOGLE_CALENDAR_ID.test(s)) return null;
  return s;
}
