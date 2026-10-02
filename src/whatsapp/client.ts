import crypto from "node:crypto";
import type { MensajeInteractivo, OpcionInteractiva, Sentimiento, Tenant } from "../types";
import { registrarMensajeSaliente } from "../observabilidad/uso";
import { conTimeout, TIMEOUT_GRAPH_MS, TIMEOUT_MEDIA_MS } from "../red/timeouts";
import { registrarRespuestaGraph } from "./estadoToken";

// ⚠️ La versión del Graph API cambia con el tiempo. Confirmá la vigente en la
// documentación de Meta antes de producción. Se deja configurable por .env.
const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? "v21.0";

// ─────────────────────────────────────────────────────────────────────────────
// Access token de WhatsApp: mismo criterio fail-closed que `calendarioDeTenant`
// en src/calendar/googleCalendar.ts (ver E4/BLOQ-05).
//
// ⚠️ AUDITORÍA ALTO-05: antes esto era `tenant.accessToken ?? process.env
// .WHATSAPP_ACCESS_TOKEN`. Un tenant sin token propio no fallaba: mandaba (y
// recibía) mensajes con el token global, es decir desde el NÚMERO DE PRUEBA DE
// META de otro negocio. El cliente lo ve con sus propios ojos y el producto
// parece roto. Ahora la env global solo cubre al tenant nombrado explícitamente
// en `WHATSAPP_ACCESS_TOKEN_TENANT_ID` (compatibilidad con el piloto, que hoy
// no tiene su propio token en la base): cualquier otro tenant sin `accessToken`
// propio falla con un error claro, nunca hereda el token de otro.
// ─────────────────────────────────────────────────────────────────────────────

/** Token disponible para este tenant, o null si no hay ninguno (propio ni legado). */
function tokenDisponible(tenant: Tenant): string | null {
  if (tenant.accessToken) return tenant.accessToken;
  const legadoTenantId = process.env.WHATSAPP_ACCESS_TOKEN_TENANT_ID;
  if (legadoTenantId && legadoTenantId === tenant.id && process.env.WHATSAPP_ACCESS_TOKEN) {
    return process.env.WHATSAPP_ACCESS_TOKEN;
  }
  return null;
}

/**
 * Token de acceso de ESTE negocio. Lanza si no hay ninguno disponible: NUNCA cae
 * al token global de otro tenant (ese es justamente el bug de ALTO-05).
 *
 * El throw sube por `postMensaje`/`descargarMedia`, que corren en la fase 2 del
 * webhook (después del 200 a Meta) y dentro del worker con reintentos: queda
 * registrado como job fallido, que es el comportamiento correcto — preferimos
 * un job en error, visible y accionable, a un mensaje enviado desde el número
 * equivocado.
 */
export function tokenDeTenant(tenant: Tenant): string {
  const token = tokenDisponible(tenant);
  if (!token) {
    throw new Error(
      `Falta el access token de WhatsApp del tenant "${tenant.id}". Configurá su token propio ` +
        `desde el panel (Mi negocio → conexión de WhatsApp) o, si es el piloto legado, definí ` +
        `WHATSAPP_ACCESS_TOKEN_TENANT_ID="${tenant.id}" junto con WHATSAPP_ACCESS_TOKEN en el .env.`,
    );
  }
  return token;
}

/**
 * ¿Puede este negocio enviar por WhatsApp (tiene token propio o el legado por env)?
 * A diferencia de `tokenDeTenant`, NO lanza: es para el health check (E10) y el panel
 * admin, donde queremos MOSTRAR el estado de la conexión, no reventar la petición.
 *
 * OJO con el nombre: responde "¿puede enviar?", NO "¿tiene token propio?". Un tenant
 * cubierto por la env de compatibilidad devuelve `true` acá y sin embargo NO tiene
 * token propio — para esa pregunta está `dependeDelTokenGlobal`.
 */
export function puedeEnviarWhatsapp(tenant: Tenant): boolean {
  return tokenDisponible(tenant) !== null;
}

/**
 * ¿Este negocio está enviando con el token GLOBAL en vez del suyo? Es un estado
 * transitorio y tolerado (compatibilidad con el piloto), pero hay que poder verlo:
 * mientras dure, el negocio depende de una env compartida y de que nadie la cambie.
 * Sirve para el warning de arranque, el health check (E10) y el panel admin.
 *
 * Se separa de `puedeEnviarWhatsapp` a propósito: mezclar ambas preguntas en un solo
 * booleano llamado "tieneTokenPropio" haría que el panel informe "conectado con su
 * token" cuando en realidad está colgado de la env — justo el estado que ALTO-05
 * quería hacer visible.
 */
export function dependeDelTokenGlobal(tenant: Tenant): boolean {
  return !tenant.accessToken && tokenDisponible(tenant) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Verificación del webhook (GET). Meta manda hub.challenge al configurarlo.
// ─────────────────────────────────────────────────────────────────────────────
export function verificarWebhook(params: URLSearchParams): { ok: boolean; challenge?: string } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return { ok: true, challenge: challenge ?? "" };
  }
  return { ok: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Validación de firma (X-Hub-Signature-256). Asegura que el POST viene de Meta.
//    Requiere el cuerpo CRUDO (string), no el JSON ya parseado.
// ─────────────────────────────────────────────────────────────────────────────
export function firmaValida(rawBody: string, firmaHeader: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !firmaHeader) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Comparación de tiempo constante.
  const a = Buffer.from(esperado);
  const b = Buffer.from(firmaHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Parseo del mensaje entrante. Devuelve solo lo que nos interesa.
// ─────────────────────────────────────────────────────────────────────────────
export interface MensajeEntrante {
  phoneNumberId: string; // a qué número llegó → identifica el tenant
  clienteWa: string; // número del cliente, SOLO dígitos (E.164 sin "+")
  texto: string; // texto del mensaje (vacío si no es texto)
  esTexto: boolean;
  /** id del mensaje en WhatsApp (msg.id). Para deduplicar reintentos de Meta. */
  messageId?: string;
  /** id del media de audio (cuando msg.type === "audio"). Para transcribir en fase 2. */
  audioId?: string;
  /** id del media de imagen (cuando msg.type === "image"). Para cotizar con visión en fase 2. */
  imagenId?: string;
  /** leyenda opcional que el cliente escribió junto a la foto. */
  imagenCaption?: string;
  /**
   * id CRUDO de la respuesta interactiva (el `id` que pusimos en el botón/fila,
   * o el `payload` del quick-reply de una plantilla, BLOQ-01/E9), cuando el
   * cliente tocó un botón o una fila de lista. Permite acciones directas (p. ej.
   * confirmar una cita) sin pasar por el agente. `texto` trae su traducción.
   */
  interactiveId?: string;
  /**
   * id del media del documento (cuando msg.type === "document"). Todavía no lo
   * descargamos ni lo procesamos (E12); solo sirve para identificarlo si el día de
   * mañana se agrega esa capacidad.
   */
  documentoId?: string;
  /** nombre de archivo del documento, si vino (para avisarle al operador qué llegó). */
  documentoNombre?: string;
  /**
   * nombre del contacto compartido (cuando msg.type === "contacts"), tomado del
   * primer contacto del arreglo. Si vino más de uno, incluye cuántos más ("+N más").
   */
  contactoNombre?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado discriminado del parseo (ROADMAP F3). `parsearEntrante` históricamente
// colapsaba dos motivos MUY distintos en un solo `null`:
//   1) el evento es un "status" (entregado/leído) u otro campo de `value` que no
//      trae `messages`: altísimo volumen, no nos interesa, NO hay que guardarlo.
//   2) el payload tiene una forma que no sabemos leer (o le faltan campos que
//      esperamos siempre presentes): es RARO y vale la pena guardarlo para
//      diagnóstico — si no, el mensaje se evapora sin dejar rastro.
// `handleWebhook.ts` necesita distinguirlos para decidir si persiste el crudo en
// `wa_webhooks_crudos`. `clasificarEntrante` expone esa distinción; `parsearEntrante`
// se mantiene intacto (mismo tipo de retorno) para no romper a sus callers/tests.
// ─────────────────────────────────────────────────────────────────────────────
export type ResultadoEntrante =
  | { tipo: "ok"; mensaje: MensajeEntrante }
  | { tipo: "ignorable" } // status u otro evento sin mensaje: no se guarda
  | { tipo: "no-parseable" }; // forma inesperada: SÍ se guarda (red de seguridad F3)

/**
 * Parte un POST de Meta en N payloads de UN solo mensaje cada uno (revisión
 * pre-venta 2026-10). Meta puede mandar en un mismo POST varios `entry` (uno por
 * WABA → varios tenants de la misma app), varios `changes` y varios `messages`;
 * `clasificarEntrante` lee solo `entry[0].changes[0].value.messages[0]`, así que
 * el resto se perdía en silencio con un 200 (Meta no reintenta).
 *
 * Cada pedazo conserva la forma original (`entry→changes→value`, con su
 * `metadata` y `contacts`) para que fluya sin cambios por `ingerirEntrante`
 * (dedup por waMessageId, crudo F3, cola). Un `change` sin mensajes (statuses)
 * sale como un pedazo propio, que se clasificará "ignorable". Si el body ni
 * siquiera tiene `entry[]`, se devuelve tal cual (camino "no-parseable").
 */
export function separarPayloadWebhook(body: any): unknown[] {
  const entries = body?.entry;
  if (!Array.isArray(entries) || entries.length === 0) return [body];
  const partes: unknown[] = [];
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes) || changes.length === 0) {
      partes.push({ ...body, entry: [entry] });
      continue;
    }
    for (const change of changes) {
      const value = change?.value;
      const mensajes = value?.messages;
      if (!Array.isArray(mensajes) || mensajes.length <= 1) {
        partes.push({ ...body, entry: [{ ...entry, changes: [change] }] });
        continue;
      }
      for (const msg of mensajes) {
        partes.push({ ...body, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [msg] } }] }] });
      }
    }
  }
  return partes;
}

export function clasificarEntrante(body: any): ResultadoEntrante {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    // Sin `value` no reconocemos ni siquiera la forma general de un webhook de
    // WhatsApp (entry→changes→value): a diferencia de un status, esto es un
    // payload que NO sabemos leer y amerita quedar guardado.
    if (value == null) return { tipo: "no-parseable" };

    const msg = value?.messages?.[0];
    if (!msg) return { tipo: "ignorable" }; // puede ser un status (entregado/leído), lo ignoramos
    // Reacción (👍/❤️ a un mensaje del bot): puro gesto de cortesía, sin intención de
    // que el bot responda. Se ignora COMPLETO —igual que un status— antes de validar
    // ningún otro campo: así no gasta una conversación de Meta ni dispara un push al
    // operador por nada (E12, el caso de mayor impacto de este ítem).
    if (msg.type === "reaction") return { tipo: "ignorable" };

    const phoneNumberId = value?.metadata?.phone_number_id;
    // Saneamos el "from" a solo dígitos: nunca confiamos en el payload crudo. Así un
    // número con caracteres raros no se cuela a la UI del panel (defensa en
    // profundidad contra XSS) y la clave del cliente queda consistente.
    const clienteWa = String(msg.from ?? "").replace(/\D/g, "");
    let esTexto = msg.type === "text";
    let texto = esTexto ? (msg.text?.body ?? "") : "";
    const audioId = msg.type === "audio" ? (msg.audio?.id ? String(msg.audio.id) : undefined) : undefined;
    const imagenId = msg.type === "image" ? (msg.image?.id ? String(msg.image.id) : undefined) : undefined;
    const imagenCaption = msg.type === "image" && msg.image?.caption ? String(msg.image.caption) : undefined;
    const documentoId = msg.type === "document" && msg.document?.id ? String(msg.document.id) : undefined;
    const documentoNombre =
      msg.type === "document" && msg.document?.filename ? String(msg.document.filename) : undefined;

    // Contacto compartido: `msg.contacts` es un ARREGLO (se puede compartir más de
    // una tarjeta a la vez). Nos quedamos con el nombre del primero para el push al
    // operador; si vinieron más, lo indicamos ("+N más") para que no se pierdan.
    let contactoNombre: string | undefined;
    if (msg.type === "contacts" && Array.isArray(msg.contacts) && msg.contacts.length > 0) {
      const primerNombre = msg.contacts[0]?.name?.formatted_name;
      if (primerNombre) {
        contactoNombre =
          msg.contacts.length > 1 ? `${primerNombre} (+${msg.contacts.length - 1} más)` : String(primerNombre);
      }
    }

    // Ubicación compartida: se trata como TEXTO (sintético, legible) para que fluya
    // por el pipeline normal del agente (cola, historial, prompt) sin ramas nuevas en
    // handleWebhook — el agente recibe las coordenadas como si el cliente las hubiera
    // escrito. Solo agrega nombre/dirección si el cliente los compartió (no siempre
    // vienen: depende de si mandó una ubicación "en vivo" o marcó un lugar con nombre).
    if (msg.type === "location" && msg.location) {
      const { latitude, longitude, name, address } = msg.location;
      const partes = [`[ubicación compartida] lat: ${latitude}, lon: ${longitude}`];
      if (name) partes.push(`nombre: ${name}`);
      if (address) partes.push(`dirección: ${address}`);
      texto = partes.join(", ");
      esTexto = true;
    }

    // Respuesta a un mensaje interactivo (el cliente tocó un botón o una fila de
    // lista, `type: "interactive"`) O el quick-reply de una PLANTILLA aprobada
    // (`type: "button"`, BLOQ-01/E9). La tratamos igual: la decodificamos a una
    // frase clara para que fluya por el mismo pipeline del agente (dedup, cola,
    // historial) sin ramas nuevas. La convención del `id`/`payload` la definimos
    // nosotros al enviar (ver `decodificarRespuestaInteractiva` abajo).
    //
    // ⚠️ Meta usa DOS formas de payload distintas según el origen del tap:
    //   • `type: "interactive"` (nuestros botones/listas nativos, enviados con
    //     `enviarBotones`/`enviarLista`): la carga viaja en
    //     `msg.interactive.button_reply.id` / `.list_reply.id`.
    //   • `type: "button"` (quick-reply de una PLANTILLA aprobada, ej. el
    //     recordatorio con `WHATSAPP_TEMPLATE_RECORDATORIO`/
    //     `tenant.plantillaRecordatorio` de E8): la carga viaja en
    //     `msg.button.payload`, con el texto visible del botón en `msg.button.text`.
    //     Antes de este fix (BLOQ-01/E9) este caso no se reconocía en absoluto y
    //     el tap caía al flujo "no puedo ver stickers ni videos".
    //
    // ⚠️ SUPUESTO que el código NO puede garantizar: `msg.button.payload` sigue
    // nuestra convención `tipo|arg` (`confirmar|<citaId>`, `mover|<citaId>`,
    // `postbien|<citaId>`, …) SOLO SI quien armó la plantilla en el WhatsApp
    // Manager configuró el quick-reply button con ESE payload exacto. Meta no
    // aplica ninguna convención automáticamente: si el dueño del negocio (o quien
    // configure la plantilla) pone un payload distinto, `decodificarRespuestaInteractiva`
    // no lo reconoce y cae al texto visible del botón (`msg.button.text`), igual
    // que con cualquier id desconocido de `type: "interactive"`.
    let interactiveId: string | undefined;
    if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      interactiveId = reply?.id ? String(reply.id) : undefined;
      const titulo = reply?.title ? String(reply.title) : "";
      texto = decodificarRespuestaInteractiva(interactiveId ?? "", titulo);
      esTexto = !!texto; // si no se pudo decodificar, cae al flujo no-texto
    } else if (msg.type === "button") {
      interactiveId = msg.button?.payload ? String(msg.button.payload) : undefined;
      const titulo = msg.button?.text ? String(msg.button.text) : "";
      texto = decodificarRespuestaInteractiva(interactiveId ?? "", titulo);
      esTexto = !!texto;
    }

    // Hay un mensaje, pero faltan campos que esperamos SIEMPRE presentes (el id
    // del número o el remitente): la forma del payload es rara, no un status.
    if (!phoneNumberId || !clienteWa) return { tipo: "no-parseable" };

    return {
      tipo: "ok",
      mensaje: {
        phoneNumberId,
        clienteWa,
        texto,
        esTexto,
        messageId: msg.id ? String(msg.id) : undefined,
        audioId,
        imagenId,
        imagenCaption,
        interactiveId,
        documentoId,
        documentoNombre,
        contactoNombre,
      },
    };
  } catch {
    return { tipo: "no-parseable" };
  }
}

export function parsearEntrante(body: any): MensajeEntrante | null {
  const r = clasificarEntrante(body);
  return r.tipo === "ok" ? r.mensaje : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocolo de mensajes interactivos (C1.2).
//
// El `id` de cada botón/fila es opaco para WhatsApp pero lo definimos nosotros con
// una convención "tipo|arg|arg…". Al enviar lo generamos (opcionHorario, etc.) y al
// llegar la respuesta lo decodificamos a una frase clara para el agente. Mantener el
// codificador y el decodificador juntos evita que se desincronicen.
// ─────────────────────────────────────────────────────────────────────────────

/** "14:00" → "2:00 p.m." (título amigable para las filas de la lista). */
function horaAmigable(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const sufijo = h < 12 ? "a.m." : "p.m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${sufijo}`;
}

/**
 * Construye una opción de lista para un horario de cita.
 *
 * Con equipo cargado (ALTO-07) el id lleva un cuarto campo con quién lo va a atender,
 * para que el tap no pierda esa elección. `empleadoNombre` va en la descripción de la
 * fila (≤72 chars), no en el título, que solo tiene 24.
 */
export function opcionHorario(
  fecha: string,
  hora: string,
  empleadoId?: string,
  empleadoNombre?: string,
): OpcionInteractiva {
  const opcion: OpcionInteractiva = {
    id: empleadoId ? `slot|${fecha}|${hora}|${empleadoId}` : `slot|${fecha}|${hora}`,
    titulo: horaAmigable(hora),
  };
  if (empleadoNombre) opcion.descripcion = `Con ${empleadoNombre}`.slice(0, 72);
  return opcion;
}

/**
 * Construye una opción de lista para elegir con QUIÉN se agenda (ALTO-07). El id
 * `empleado|<servicioId>|<empleadoId>` lleva el servicio para que el agente no dependa
 * de recordarlo del turno anterior; `empleadoId` vacío = "cualquiera".
 */
export function opcionEmpleado(servicioId: string, empleadoId: string, nombre: string): OpcionInteractiva {
  return { id: `empleado|${servicioId}|${empleadoId}`, titulo: nombre.slice(0, 24) };
}

/** Botones del recordatorio de cita (C1.3): confirmar o pedir reprogramación. */
export function botonesRecordatorio(citaId: string): OpcionInteractiva[] {
  return [
    { id: `confirmar|${citaId}`, titulo: "Confirmo ✅" },
    { id: `mover|${citaId}`, titulo: "Reprogramar" },
  ];
}

/** true si la respuesta interactiva es una CONFIRMACIÓN de cita (acción directa). */
export function esConfirmacionCita(interactiveId: string | undefined): string | null {
  if (!interactiveId) return null;
  const [tipo, citaId] = interactiveId.split("|");
  return tipo === "confirmar" && citaId ? citaId : null;
}

/**
 * Botones del seguimiento post-servicio, plan Básico (C3.1, legacy): 2 opciones.
 * "Todo bien" pide la reseña; "Tuve un problema" escala a humano. Sin tracking en
 * wa_seguimientos (eso es exclusivo del flujo Pro, ver botonesPostServicioPro).
 */
export function botonesPostServicio(citaId: string): OpcionInteractiva[] {
  return [
    { id: `postbien|${citaId}`, titulo: "Todo bien 👍" },
    { id: `postmal|${citaId}`, titulo: "Tuve un problema" },
  ];
}

/**
 * Botones del seguimiento post-servicio, plan Pro (Carril D, 1.3 — motor de reseñas
 * completo): 3 opciones en vez de 2. Solo "Excelente" pide la reseña; "Bien" agradece
 * sin pedirla (evita reseñas de 3-4 estrellas); "Mal" escala igual que en Básico.
 */
export function botonesPostServicioPro(citaId: string): OpcionInteractiva[] {
  return [
    { id: `postexcelente|${citaId}`, titulo: "Excelente 😃" },
    { id: `postok|${citaId}`, titulo: "Bien 🙂" },
    { id: `postmal|${citaId}`, titulo: "Mal 😞" },
  ];
}

/**
 * Si la respuesta interactiva es del seguimiento post-servicio (C3.1 + Carril D 1.3),
 * devuelve la cita y el sentimiento marcado. Cubre AMBOS protocolos (Básico de 2
 * botones y Pro de 3): "postbien"/"postexcelente" → positivo (pide reseña); "postok"
 * → neutral (agradece sin pedir reseña, solo existe en Pro); "postmal" → negativo
 * (escala a humano). Acción directa: no pasa por el agente ni por modo humano.
 */
export function respuestaPostServicio(interactiveId: string | undefined): { citaId: string; sentimiento: Sentimiento } | null {
  if (!interactiveId) return null;
  const [tipo, citaId] = interactiveId.split("|");
  if (!citaId) return null;
  if (tipo === "postbien" || tipo === "postexcelente") return { citaId, sentimiento: "positivo" };
  if (tipo === "postok") return { citaId, sentimiento: "neutral" };
  if (tipo === "postmal") return { citaId, sentimiento: "negativo" };
  return null;
}

/**
 * Traduce el `id` de una respuesta interactiva a la frase que "diría" el cliente,
 * para inyectarla al agente como si la hubiera escrito. Si el id no matchea ninguna
 * convención conocida, cae al título visible del botón/fila.
 */
function decodificarRespuestaInteractiva(id: string, titulo: string): string {
  const [tipo, ...resto] = id.split("|");
  // `slot|fecha|hora` (sin equipo) y `slot|fecha|hora|empleadoId` (con equipo, ALTO-07).
  // Se aceptan los dos largos a propósito: cuando se agregó el 4º campo podía haber
  // listas ya enviadas al cliente esperando respuesta, y esas siguen decodificando bien.
  if (tipo === "slot" && (resto.length === 2 || resto.length === 3)) {
    const [fecha, hora, empleadoId] = resto;
    const con = empleadoId ? ` con el id de empleado ${empleadoId}` : "";
    return `Quiero agendar para el ${fecha} a las ${hora}${con}.`;
  }
  // Elección de con quién atenderse (ALTO-07). `empleadoId` vacío = le da igual.
  if (tipo === "empleado" && resto.length === 2) {
    const [servicioId, empleadoId] = resto;
    return empleadoId
      ? `Quiero agendar ${servicioId} con el id de empleado ${empleadoId}.`
      : `Quiero agendar ${servicioId} con cualquiera que esté disponible.`;
  }
  // Confirmación de cita: se maneja como acción directa en handleWebhook (no llega
  // al agente), pero igual dejamos un texto legible para el historial del panel.
  if (tipo === "confirmar") return "Confirmo mi cita ✅";
  // Pedido de reprogramar desde el recordatorio: fluye al agente, que arranca el
  // flujo de reprogramación (C1.1) identificando la cita por el número del cliente.
  if (tipo === "mover") return "Quiero reprogramar mi cita.";
  // Seguimiento post-servicio (C3.1 + Carril D 1.3): también son acción directa en
  // handleWebhook, pero dejamos un texto legible para el historial del panel.
  if (tipo === "postbien") return "Todo bien con el servicio 👍";
  if (tipo === "postexcelente") return "Excelente el servicio 😃";
  if (tipo === "postok") return "Bien el servicio 🙂";
  if (tipo === "postmal") return "Tuve un problema con el servicio 😕";
  return titulo;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Envío de mensajes a la Graph API, con REINTENTOS ante fallos transitorios.
//
// Meta a veces devuelve hipos momentáneos y recuperables (los marca con
// `is_transient: true`, p. ej. «(#2) Service temporarily unavailable»), además de
// rate limits (429) y errores de servidor (5xx). Sin reintento, un solo hipo deja
// al cliente sin respuesta — fue justo lo que pasó: una respuesta del bot se
// perdió por un error transitorio y el cliente esperó horas. Reintentamos con
// backoff exponencial. Esto corre en la fase 2 (después del 200 a Meta), así que
// unos segundos extra no bloquean el webhook.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_INTENTOS_ENVIO = 3;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Backoff antes de reintentar tras el intento `n` que falló: 500ms, 1500ms… (tope 5s).
const retardoMs = (intentoFallido: number) => Math.min(500 * 3 ** (intentoFallido - 1), 5000);

function statusEsTransitorio(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Códigos de error de Meta tratados como transitorios aunque lleguen con HTTP 400/200.
// Ref Meta: 1 (API desconocido), 2 (servicio no disponible), 4/80007/130429 (rate
// limit), 131000 («algo salió mal»), 131016 (servicio no disponible), 133016.
const CODIGOS_META_TRANSITORIOS = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 133016]);

/**
 * Error de la Graph API que lleva la marca de si vale la pena reintentar más tarde
 * (E7): `postMensaje` ya reintenta en caliente, pero si el hipo dura más que esos
 * segundos la COLA durable reintenta el job entero con backoff — y para eso tiene que
 * poder distinguir "Meta caído un rato" (transitorio) de "token inválido / número
 * bloqueado" (permanente: reintentar no cambia nada). Mismo texto de siempre en
 * `message`; la marca va aparte (ver `esErrorTransitorio` en src/red/transitorio.ts).
 */
export class ErrorGraph extends Error {
  constructor(
    mensaje: string,
    readonly status: number | undefined,
    readonly transitorio: boolean,
    opciones?: { cause?: unknown },
  ) {
    super(mensaje, opciones);
    this.name = "ErrorGraph";
  }
}

function cuerpoEsTransitorio(detalle: string): boolean {
  try {
    const err = JSON.parse(detalle)?.error;
    if (!err) return false;
    if (err.is_transient === true) return true;
    return typeof err.code === "number" && CODIGOS_META_TRANSITORIOS.has(err.code);
  } catch {
    return false; // no es JSON de Meta → no asumimos transitorio
  }
}

// POST genérico a /{phone_number_id}/messages con reintentos. `etiqueta` arma el
// mensaje de error (se conserva el formato «Error enviando WhatsApp (status): …»).
async function postMensaje(
  tenant: Tenant,
  contenido: Record<string, unknown>,
  etiqueta: string,
  plantillaCategoria?: "marketing" | "utilidad",
): Promise<void> {
  const token = tokenDeTenant(tenant);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${tenant.phoneNumberId}/messages`;
  const cuerpo = JSON.stringify({ messaging_product: "whatsapp", ...contenido });

  let ultimoError: Error | null = null;
  for (let intento = 1; intento <= MAX_INTENTOS_ENVIO; intento++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: cuerpo,
        // Sin señal, undici espera ~300 s por intento × 3 intentos = 15 min colgado.
        signal: conTimeout(TIMEOUT_GRAPH_MS),
      });
    } catch (e) {
      // fetch lanzó (DNS/red/timeout): siempre transitorio.
      ultimoError = new ErrorGraph(e instanceof Error ? e.message : String(e), undefined, true, { cause: e });
      if (intento < MAX_INTENTOS_ENVIO) {
        console.warn(`[whatsapp] red falló (intento ${intento}/${MAX_INTENTOS_ENVIO}), reintento: ${ultimoError.message}`);
        await dormir(retardoMs(intento));
        continue;
      }
      throw ultimoError;
    }

    if (res.ok) {
      // Contador de uso mensual (Carril D, 0.2): solo se cuenta un envío exitoso.
      registrarMensajeSaliente(tenant.id, plantillaCategoria);
      registrarRespuestaGraph(tenant.id, true, res.status);
      return;
    }

    const detalle = await res.text();
    // Token revocado/inválido (401 / Graph 190): marca el tenant y alerta a la
    // plataforma (whatsapp/estadoToken.ts). Solo observa: el flujo de abajo
    // (reintento o throw) queda idéntico.
    registrarRespuestaGraph(tenant.id, false, res.status, detalle);
    const transitorio = statusEsTransitorio(res.status) || cuerpoEsTransitorio(detalle);
    ultimoError = new ErrorGraph(`Error ${etiqueta} (${res.status}): ${detalle}`, res.status, transitorio);
    if (transitorio && intento < MAX_INTENTOS_ENVIO) {
      console.warn(`[whatsapp] envío transitorio falló (intento ${intento}/${MAX_INTENTOS_ENVIO}), reintento: ${detalle.slice(0, 140)}`);
      await dormir(retardoMs(intento));
      continue;
    }
    throw ultimoError; // error permanente, o se agotaron los intentos
  }
  throw ultimoError ?? new Error(`Error ${etiqueta}: se agotaron los reintentos`);
}

// Envío de un mensaje de texto al cliente.
export async function enviarTexto(tenant: Tenant, paraWa: string, texto: string): Promise<void> {
  await postMensaje(
    tenant,
    { to: paraWa, type: "text", text: { body: texto.slice(0, 4096) } }, // 4096 = límite de WhatsApp
    "enviando WhatsApp",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b) Envío de MENSAJES INTERACTIVOS (botones y listas nativas de WhatsApp).
//     Solo Graph API, sin dependencias nuevas. La respuesta del cliente llega como
//     un mensaje `type: "interactive"` que parsearEntrante decodifica.
//
//     Límites de Meta (se recortan defensivamente para no fallar el envío):
//       • Botones: hasta 3; título ≤20 chars.
//       • Lista: hasta 10 filas en total; título de fila ≤24, descripción ≤72;
//         texto del botón que abre la lista ≤20.
//       • Cuerpo ≤1024 chars.
// ─────────────────────────────────────────────────────────────────────────────
const LIMITE_BOTONES = 3;
const LIMITE_FILAS_LISTA = 10;

export async function enviarBotones(
  tenant: Tenant,
  paraWa: string,
  cuerpo: string,
  botones: OpcionInteractiva[],
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: cuerpo.slice(0, 1024) },
        action: {
          buttons: botones.slice(0, LIMITE_BOTONES).map((b) => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: b.titulo.slice(0, 20) },
          })),
        },
      },
    },
    "enviando botones WhatsApp",
  );
}

export async function enviarLista(
  tenant: Tenant,
  paraWa: string,
  cuerpo: string,
  textoBoton: string,
  filas: OpcionInteractiva[],
  tituloSeccion = "Opciones",
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: cuerpo.slice(0, 1024) },
        action: {
          button: textoBoton.slice(0, 20),
          sections: [
            {
              title: tituloSeccion.slice(0, 24),
              rows: filas.slice(0, LIMITE_FILAS_LISTA).map((f) => ({
                id: f.id.slice(0, 200),
                title: f.titulo.slice(0, 24),
                ...(f.descripcion ? { description: f.descripcion.slice(0, 72) } : {}),
              })),
            },
          ],
        },
      },
    },
    "enviando lista WhatsApp",
  );
}

/** Despacha un MensajeInteractivo al canal correcto (botones o lista). */
export async function enviarInteractivo(
  tenant: Tenant,
  paraWa: string,
  msg: MensajeInteractivo,
): Promise<void> {
  if (msg.tipo === "botones") {
    await enviarBotones(tenant, paraWa, msg.cuerpo, msg.opciones);
  } else {
    await enviarLista(tenant, paraWa, msg.cuerpo, msg.textoBoton ?? "Ver opciones", msg.opciones);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Descarga de media (audio/imagen) desde la Graph API.
//    Paso 1: GET /{mediaId} → devuelve la URL temporal del archivo.
//    Paso 2: GET de esa URL con el token → devuelve los bytes.
// ─────────────────────────────────────────────────────────────────────────────
export async function descargarMedia(
  tenant: Tenant,
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = tokenDeTenant(tenant);

  // Los fallos se lanzan como ErrorGraph (E7): un 5xx/429 o un corte de red al bajar
  // la foto/el audio es transitorio y la cola puede reintentar el job más tarde.
  let metaRes: Response;
  try {
    metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: conTimeout(TIMEOUT_GRAPH_MS),
    });
  } catch (e) {
    throw new ErrorGraph(e instanceof Error ? e.message : String(e), undefined, true, { cause: e });
  }
  if (!metaRes.ok) {
    const detalle = await metaRes.text();
    registrarRespuestaGraph(tenant.id, false, metaRes.status, detalle); // ver postMensaje
    throw new ErrorGraph(
      `Error obteniendo URL de media ${mediaId} (${metaRes.status}): ${detalle.slice(0, 140)}`,
      metaRes.status,
      statusEsTransitorio(metaRes.status) || cuerpoEsTransitorio(detalle),
    );
  }
  registrarRespuestaGraph(tenant.id, true, metaRes.status);
  const { url, mime_type } = (await metaRes.json()) as { url: string; mime_type: string };

  // Timeout más holgado que el resto de Graph: acá viajan bytes (audio/foto), no JSON.
  let archivoRes: Response;
  try {
    archivoRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: conTimeout(TIMEOUT_MEDIA_MS),
    });
  } catch (e) {
    throw new ErrorGraph(e instanceof Error ? e.message : String(e), undefined, true, { cause: e });
  }
  if (!archivoRes.ok) {
    throw new ErrorGraph(
      `Error descargando media (${archivoRes.status})`,
      archivoRes.status,
      statusEsTransitorio(archivoRes.status),
    );
  }
  const buffer = Buffer.from(await archivoRes.arrayBuffer());
  return { buffer, mimeType: mime_type ?? "application/octet-stream" };
}

/**
 * Descarga una foto de WhatsApp y la devuelve como data URL
 * ("data:image/jpeg;base64,…"), lista para adjuntarla a un mensaje multimodal de
 * OpenAI (visión, C1.5).
 *
 * ⚠️ Carril F, F9: `handleWebhook.ts` ya NO usa esta función para lo que se
 * persiste en `wa_mensajes.media_url` (llama a `descargarMedia` directo, porque
 * necesita el `Buffer` crudo para subirlo a Supabase Storage). Esta función sigue
 * viva por si algún caller solo necesita el data URL en memoria (visión, tests).
 */
export async function descargarImagenComoDataUrl(tenant: Tenant, mediaId: string): Promise<string> {
  const { buffer, mimeType } = await descargarMedia(tenant, mediaId);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Envío de un MENSAJE DE PLANTILLA (template).
//    Necesario para iniciar conversación FUERA de la ventana de 24 h de Meta
//    (caso típico: recordatorios de cita). La plantilla debe estar APROBADA
//    en el WhatsApp Manager del negocio y sus variables {{1}}, {{2}}… se
//    pasan en `parametros` (en orden).
// ─────────────────────────────────────────────────────────────────────────────
export async function enviarPlantilla(
  tenant: Tenant,
  paraWa: string,
  nombrePlantilla: string,
  idioma: string,
  parametros: string[],
  // Categoría de la plantilla ante Meta (para el contador de uso, Carril D 0.2):
  // "marketing" = campañas segmentadas (C3.2); "utilidad" = recordatorios fuera de
  // la ventana de 24 h (default, ya que es el caso más frecuente hoy).
  categoria: "marketing" | "utilidad" = "utilidad",
): Promise<void> {
  await postMensaje(
    tenant,
    {
      to: paraWa,
      type: "template",
      template: {
        name: nombrePlantilla,
        language: { code: idioma },
        components: parametros.length
          ? [
              {
                type: "body",
                parameters: parametros.map((texto) => ({ type: "text", text: texto })),
              },
            ]
          : undefined,
      },
    },
    "enviando plantilla WhatsApp",
    categoria,
  );
}
