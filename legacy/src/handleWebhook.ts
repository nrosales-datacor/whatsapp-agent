import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Conversacion, MensajeConversacion, PendienteSerializado, Repositorio, Tenant } from "./types";
import {
  obtenerTenantPausadoPorPhoneNumberId,
  obtenerTenantPorPhoneNumberId,
  refrescarSiFaltaPhoneNumberId,
} from "./config/tenantStore";
import {
  clasificarEntrante,
  separarPayloadWebhook,
  enviarTexto,
  enviarInteractivo,
  esConfirmacionCita,
  respuestaPostServicio,
  descargarMedia,
  type MensajeEntrante,
} from "./whatsapp/client";
import type { MensajeInteractivo } from "./types";
import { transcribirAudio } from "./whatsapp/transcribir";
import { pideHumano, modoHumanoVencido } from "./whatsapp/traspasoHumano";
import {
  almacenConsentimiento,
  esPedidoDeBaja,
  pedirConsentimientoMarketing,
  procesarRespuestaConsentimiento,
  respuestaConsentimiento,
} from "./campaigns/consentimiento";
import { correrAgente } from "./agent/runAgent";
import { HISTORIAL_MAX_MENSAJES, recortarHistorial } from "./agent/historial";
import { notificarOperador } from "./panel/notificaciones";
import { registrarMensaje } from "./observabilidad/metricas";
import { log } from "./observabilidad/log";
import { enmascararTelefono } from "./observabilidad/privacidad";
import { registrarMensajeEntrante } from "./observabilidad/uso";
import { estadoCuotasDelMes } from "./observabilidad/cuotas";
import { aplicarFrenosPorCliente } from "./red/limiteCliente";
import { permitirIngesta, RATE_LIMIT_DIFERIR_SEG } from "./red/limiteIngesta";
import { guardarCrudo } from "./db/webhooksCrudos";
import { resolverMediaAPersistir } from "./storage/supabaseStorage";
import { esErrorTransitorio } from "./red/transitorio";
import { textoCliente, TURNO_FOTO_SIN_COMENTARIO } from "./config/textos";
import type { schema } from "./db/schema";

type DB = PostgresJsDatabase<typeof schema>;

// "Conversación iniciada" ≈ primer mensaje tras 24 h de silencio (aproxima el modelo
// de cobro de Meta: una conversación = una ventana de 24 h), para los contadores de
// uso mensual por tenant (Carril D, 0.2).
const VENTANA_CONVERSACION_MS = 24 * 60 * 60 * 1000;
export function esConversacionIniciada(mensajesPrevios: MensajeConversacion[]): boolean {
  const ultimo = mensajesPrevios[mensajesPrevios.length - 1];
  if (!ultimo) return true;
  return Date.now() - new Date(ultimo.creadoEn).getTime() > VENTANA_CONVERSACION_MS;
}

// Los textos al cliente final viven en src/config/textos.ts (E11): plantillas por
// registro (vos/tú/usted) del negocio, con override por tenant.

/** Aviso de transparencia que se manda UNA vez por cliente (cumple opt-in/política). */
function avisoBot(tenant: Tenant): string {
  return textoCliente(tenant, "avisoBot", { negocio: tenant.nombre });
}

/**
 * Aviso de traspaso. Si en el mismo turno ya quedó guardada una cita (agendada,
 * reprogramada o cancelada), se confirma PRIMERO con texto fijo: el cliente no debe
 * creer que no agendó y reintentar (revisión pre-venta 2026-10).
 */
function textoEscalada(tenant: Tenant, confirmacion?: string): string {
  const escalada = textoCliente(tenant, "escalada");
  return confirmacion ? `${confirmacion}\n\n${escalada}` : escalada;
}

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
// `correlationId` (F14, opcional): generado en `ingerirEntrante`; ver el
// comentario de `PendienteSerializado.correlationId` en types.ts.
export type Pendiente =
  | { clase: "no-texto"; tenant: Tenant; entrante: MensajeEntrante; conv: Conversacion; correlationId?: string }
  | { clase: "documento"; tenant: Tenant; entrante: MensajeEntrante; conv: Conversacion; correlationId?: string }
  | { clase: "contacto"; tenant: Tenant; entrante: MensajeEntrante; conv: Conversacion; correlationId?: string }
  | {
      clase: "audio";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
      correlationId?: string;
    }
  | {
      clase: "imagen";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
      correlationId?: string;
    }
  | {
      clase: "texto";
      tenant: Tenant;
      entrante: MensajeEntrante;
      conv: Conversacion;
      primerContacto: boolean;
      historialPrevio: MensajeConversacion[];
      correlationId?: string;
    };

/**
 * Si la conversación está en modo humano pero el equipo no actuó en N horas
 * (`modoHumanoVencido`), se la devuelve al bot ANTES de decidir si responder. Muta
 * `conv.modo` para que el resto del turno ya la vea en "bot". Si falla la escritura,
 * se deja en humano (el comportamiento previo, seguro).
 */
async function reactivarBotSiVencio(
  repo: Repositorio,
  tenant: Tenant,
  conv: Conversacion,
  historial: MensajeConversacion[],
): Promise<void> {
  if (!modoHumanoVencido(conv, historial)) return;
  try {
    await repo.setModoConversacion(tenant.id, conv.id, "bot");
    conv.modo = "bot";
    console.log(`[humano] conv ${conv.id}: sin actividad del equipo, vuelve al bot`);
  } catch (e) {
    console.error("[humano] no se pudo devolver la conversación al bot:", e);
  }
}

/**
 * Mensaje entrante a un negocio PAUSADO: se persiste en su conversación (deduplicado por
 * waMessageId, igual que el camino normal) SIN encolar job — nadie le responde, no se
 * transcribe ni se descarga la foto, no cuenta para el uso mensual. El contenido es el
 * texto tal cual o un marcador del tipo de mensaje, mismo criterio que la rama no-texto.
 */
async function guardarEntranteDePausado(repo: Repositorio, tenant: Tenant, entrante: MensajeEntrante): Promise<void> {
  const conv = await repo.obtenerOConversacion(tenant.id, entrante.clienteWa);
  const contenido =
    entrante.esTexto && entrante.texto.trim()
      ? entrante.texto
      : entrante.audioId
        ? "[audio]"
        : entrante.imagenId
          ? entrante.imagenCaption
            ? `[foto] ${entrante.imagenCaption}`
            : "[foto]"
          : entrante.documentoId
            ? `[documento] ${entrante.documentoNombre ?? "sin nombre"}`
            : entrante.contactoNombre
              ? `[contacto] ${entrante.contactoNombre}`
              : "[multimedia]";
  await repo.guardarMensaje(tenant.id, conv.id, {
    rol: "user",
    contenido,
    creadoEn: new Date().toISOString(),
    waMessageId: entrante.messageId,
  });
  console.warn(`[webhook] negocio ${tenant.id} PAUSADO: mensaje guardado sin responder (conv ${conv.id})`);
}

/**
 * true si el texto entrante dispara una acción directa de `responderEntrante` (no pasa
 * por el agente). Tiene que coincidir con las ramas de acción de la rama de texto.
 */
export function esAccionDirecta(entrante: Pick<MensajeEntrante, "texto" | "interactiveId">): boolean {
  return (
    !!esConfirmacionCita(entrante.interactiveId) ||
    !!respuestaPostServicio(entrante.interactiveId) ||
    !!respuestaConsentimiento(entrante.interactiveId) ||
    esPedidoDeBaja(entrante.texto) ||
    pideHumano(entrante.texto)
  );
}

/**
 * FASE 1 — rápida, se ejecuta ANTES de responder 200 a Meta.
 * Valida el evento, persiste el mensaje entrante y deduplica reintentos. Si esto
 * lanza, el server NO responde 200 y Meta reintrega; como guardamos por waMessageId,
 * el reintento no genera duplicados. Devuelve null si no hay nada que responder
 * (evento ignorado, número sin tenant, mensaje duplicado, o payload no parseable).
 *
 * `db`, si viene, es donde se guarda el crudo (ROADMAP F3) cuando el mensaje se
 * descarta por tenant desconocido o payload no parseable — los DOS casos que
 * antes de F3 tiraban el mensaje sin dejar rastro (a diferencia del camino feliz,
 * que ya persiste todo en `guardarEntranteYEncolar`). Sin `db` (dev/tests sin
 * DATABASE_URL) se preserva el comportamiento previo: se descarta sin persistir,
 * porque no hay dónde hacerlo.
 */
export async function ingerirEntrante(body: unknown, repo: Repositorio, db?: DB): Promise<Pendiente | null> {
  const clasif = clasificarEntrante(body);

  if (clasif.tipo === "ignorable") return null; // status u otro evento sin mensaje: alto volumen, no interesa

  if (clasif.tipo === "no-parseable") {
    // Forma de payload que no sabemos leer (E9/E12: tipos de mensaje aún no
    // soportados). Antes se evaporaba con un `parsearEntrante` que devolvía null
    // igual que un status; ahora queda un rastro forense para diagnosticar.
    console.warn("[webhook] payload con una forma que no sabemos leer (se guarda en wa_webhooks_crudos si hay DB)");
    if (db) await guardarCrudo(db, { payload: body, phoneNumberId: null, waMessageId: null, motivo: "no_parseable" });
    return null;
  }

  const entrante = clasif.mensaje;

  const tenant = obtenerTenantPorPhoneNumberId(entrante.phoneNumberId);
  if (!tenant) {
    // Negocio PAUSADO por la plataforma (falta de pago, PROCESO-COBRO-MANUAL.md): el bot
    // NO responde, pero el mensaje se guarda en la conversación del cliente para que el
    // dueño lo vea al reactivarse — en vez de ir a wa_webhooks_crudos, donde el reproceso
    // lo terminaría descartando como "tenant desconocido" mientras dure la pausa.
    const pausado = obtenerTenantPausadoPorPhoneNumberId(entrante.phoneNumberId);
    if (pausado) {
      await guardarEntranteDePausado(repo, pausado, entrante);
      return null;
    }
    console.warn("[webhook] mensaje a un phone_number_id sin tenant:", entrante.phoneNumberId);
    // Quizás es un negocio recién dado de alta que el caché aún no tiene: gatilla un
    // refresh (fire-and-forget, con cooldown) para tomarlo en el próximo mensaje.
    refrescarSiFaltaPhoneNumberId(entrante.phoneNumberId);
    if (db) {
      await guardarCrudo(db, {
        payload: body,
        phoneNumberId: entrante.phoneNumberId,
        waMessageId: entrante.messageId ?? null,
        motivo: "tenant_desconocido",
      });
    }
    return null;
  }

  // F14 (observabilidad por tenant): correlation id generado ACÁ, antes de encolar,
  // para reconstruir el recorrido completo de este mensaje en los logs
  // estructurados (ingesta → job de la cola → respuesta). Viaja gratis dentro del
  // `payload` JSONB de wa_jobs (ver PendienteSerializado.correlationId en types.ts).
  const correlationId = randomUUID();

  // F10 (rate limit de ingesta por tenant): token bucket en memoria, techo por plan
  // (src/red/limiteIngesta.ts). Al excederse el mensaje se persiste y encola IGUAL
  // (F3: nunca se pierde) pero con `ejecutarDespuesDe` diferido — se degrada la
  // latencia de esa respuesta puntual, no la entrega. undefined = sin exceder, el
  // job queda con el default de la columna (now(), el worker lo toma de inmediato).
  const ejecutarDespuesDe = permitirIngesta(tenant.id, tenant.plan)
    ? undefined
    : new Date(Date.now() + RATE_LIMIT_DIFERIR_SEG * 1000);
  if (ejecutarDespuesDe) {
    console.warn(`[rate-limit] tenant ${tenant.id} excedió el límite de ingesta: job diferido ${RATE_LIMIT_DIFERIR_SEG}s`);
  }

  // Mensajes no-texto: audio (notas de voz) los transcribimos en fase 2, fotos las
  // cotizamos con visión (C1.5); documento y contacto (E12) le avisan al cliente que
  // no se pueden procesar Y notifican al operador con contexto (nombre de archivo o
  // del contacto); el resto (stickers, video) cae en el genérico. Igual guardamos un
  // marcador deduplicado por waMessageId para que el operador vea que llegó algo.
  // (La reacción se ignora antes, en parsearEntrante; la ubicación entra por la rama
  // de texto de más abajo porque parsearEntrante ya la convirtió en texto sintético.)
  if (!entrante.esTexto || !entrante.texto.trim()) {
    const esAudio = !!entrante.audioId;
    const esImagen = !!entrante.imagenId;
    const esDocumento = !!entrante.documentoId;
    const esContacto = !!entrante.contactoNombre;
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
          : esDocumento
            ? `[documento] ${entrante.documentoNombre ?? "sin nombre"}`
            : esContacto
              ? `[contacto] ${entrante.contactoNombre}`
              : "[multimedia]",
      creadoEn: new Date().toISOString(),
      waMessageId: entrante.messageId,
    };
    const clase = esAudio ? "audio" : esImagen ? "imagen" : esDocumento ? "documento" : esContacto ? "contacto" : "no-texto";
    const payload: PendienteSerializado = {
      clase,
      tenantId: tenant.id,
      entrante,
      conv: { ...conv, mensajes: [] },
      correlationId,
      ...(esAudio || esImagen ? { primerContacto, historialPrevio } : {}),
      // La foto y el audio tienen efectos propios (descarga/transcripción): nunca ceden
      // ante otro mensaje, pero sí releen el historial y absorben textos anteriores.
      agrupable: false,
      releeHistorial: esAudio || esImagen,
    };
    const esNuevo = await repo.guardarEntranteYEncolar(conv.id, msg, payload, ejecutarDespuesDe);
    if (!esNuevo) return null;
    registrarMensaje(tenant.id);
    registrarMensajeEntrante(tenant.id, esConversacionIniciada(historialPrevio));
    log.info("mensaje_ingresado", { correlationId, tenantId: tenant.id, conversacionId: conv.id, clase });
    if (esAudio) return { clase: "audio", tenant, entrante, conv, primerContacto, historialPrevio, correlationId };
    if (esImagen) return { clase: "imagen", tenant, entrante, conv, primerContacto, historialPrevio, correlationId };
    if (esDocumento) return { clase: "documento", tenant, entrante, conv, correlationId };
    if (esContacto) return { clase: "contacto", tenant, entrante, conv, correlationId };
    return { clase: "no-texto", tenant, entrante, conv, correlationId };
  }

  log.info("entrante", { correlationId, tenantId: tenant.id, cliente: enmascararTelefono(entrante.clienteWa), largo: entrante.texto.length });

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
  // Una acción directa (BAJA, "Confirmo", consentimiento, post-servicio, pedir una
  // persona) no pasa por el agente: no puede cederse ante otro mensaje ni absorberlo.
  const esTurnoDelAgente = !esAccionDirecta(entrante);
  const payload: PendienteSerializado = {
    clase: "texto",
    tenantId: tenant.id,
    entrante,
    conv: { ...conv, mensajes: [] },
    primerContacto,
    historialPrevio,
    correlationId,
    agrupable: esTurnoDelAgente,
    releeHistorial: esTurnoDelAgente,
  };
  const esNuevo = await repo.guardarEntranteYEncolar(conv.id, msg, payload, ejecutarDespuesDe);
  if (!esNuevo) {
    console.log(`[webhook] mensaje duplicado ignorado (${entrante.messageId ?? "sin id"})`);
    return null;
  }
  registrarMensaje(tenant.id);
  registrarMensajeEntrante(tenant.id, esConversacionIniciada(historialPrevio));
  log.info("mensaje_ingresado", { correlationId, tenantId: tenant.id, conversacionId: conv.id, clase: "texto" });

  return { clase: "texto", tenant, entrante, conv, primerContacto, historialPrevio, correlationId };
}

/**
 * E5-a (ráfaga de mensajes): `historialPrevio` en el payload es un SNAPSHOT tomado
 * en la ingesta (fase 1). Si entre la ingesta y este momento llegaron más mensajes
 * de la MISMA conversación (ráfaga: 2-3 mensajes seguidos, patrón normal en
 * WhatsApp), ese snapshot quedó viejo y el agente respondería sin verlos. Releemos
 * la conversación fresca de la base justo antes de armar el prompt.
 *
 * La relectura incluye el turno actual (ya se persistió en la ingesta, ANTES de
 * encolar el job) — hay que excluirlo del historial porque `correrAgente` lo recibe
 * aparte como `textoUsuario` y lo agrega él mismo como último turno; si no lo
 * excluyéramos, el agente vería el mensaje del cliente duplicado. Se excluye por
 * `waMessageId` (identifica el mensaje entrante sin ambigüedad); si no hay
 * `waMessageId` (caso raro), se recorta el último mensaje como mejor esfuerzo.
 *
 * Si la relectura falla o la conversación ya no existe (no debería pasar en la
 * práctica), cae de vuelta al snapshot del payload para no dejar al cliente sin
 * respuesta.
 *
 * Revisión pre-venta 2026-10: se lee con `mensajesRecientes` (liviana, solo los
 * últimos N) en vez de `obtenerConversacionPorId` (100 mensajes + media firmada, pensada
 * para el panel), y el resultado —o el snapshot— se recorta a la ventana del agente
 * (`recortarHistorial`: `AGENTE_HISTORIAL_MAX_MENSAJES` / `AGENTE_HISTORIAL_MAX_DIAS`).
 * Se pide UNO más que el tope porque la relectura trae también el turno actual, que se
 * excluye acá.
 */
async function historialFresco(
  repo: Repositorio,
  tenant: Tenant,
  conv: Conversacion,
  waMessageIdActual: string | undefined,
  snapshot: MensajeConversacion[],
): Promise<MensajeConversacion[]> {
  try {
    const recientes = await repo.mensajesRecientes(tenant.id, conv.id, HISTORIAL_MAX_MENSAJES + 1);
    if (!recientes.length) return recortarHistorial(snapshot);
    return recortarHistorial(
      waMessageIdActual ? recientes.filter((m) => m.waMessageId !== waMessageIdActual) : recientes.slice(0, -1),
    );
  } catch (e) {
    console.error("[historialFresco] no se pudo releer la conversación, se usa el snapshot de la ingesta:", e);
    return recortarHistorial(snapshot);
  }
}

/**
 * F10 (PLAN-ESCALA-MULTITENANT.md): al 100% del tope mensual del tenant, el bot deja
 * de llamar al LLM — responde un mensaje fijo (configurable por tenant) y escala la
 * conversación a modo humano, mismo mecanismo que usa `escalar` más abajo (nunca
 * silencio: el cliente final siempre recibe algo). Devuelve `true` si se aplicó el
 * tope (el caller NO debe invocar a correrAgente); `false` si el tenant tiene
 * margen (o tiene el interruptor activado, o su plan no tiene tope).
 *
 * Mismo tratamiento para el tope mensual de GASTO de LLM en USD (por plan, con
 * override por tenant, ver billing/planes.ts): misma lectura de `wa_uso_mensual`,
 * texto neutro (clave "topeGasto" de config/textos.ts) y su propio aviso al operador.
 *
 * `db` opcional (ver estadoCuotasDelMes): en producción el pool singleton alcanza;
 * los tests de fiabilidad (PGlite) lo pasan explícito.
 */
async function aplicarTopeMensualSiCorresponde(
  tenant: Tenant,
  repo: Repositorio,
  entrante: MensajeEntrante,
  conv: Conversacion,
  primerContacto: boolean,
  db?: DB,
): Promise<boolean> {
  const { conversaciones: estado, gastoLlm } = await estadoCuotasDelMes(tenant, db);
  if (!estado.excedido && !gastoLlm.excedido) return false;

  if (estado.excedido) {
    console.warn(`[tope-mensual] tenant ${tenant.id} alcanzó el tope (${estado.usados}/${estado.tope}): escala a humano sin llamar al LLM`);
  } else {
    log.warn("tope_gasto_llm_excedido", { tenantId: tenant.id, gastoUsd: gastoLlm.gastoUsd, topeUsd: gastoLlm.topeUsd });
  }
  await repo.setModoConversacion(tenant.id, conv.id, "humano");
  // F10: el texto del tope es editable en "Mi negocio" (mensajeTopeExcedido); el del
  // gasto de IA es neutro a propósito — red de seguridad interna, no "se acabó el servicio".
  let salida = estado.excedido
    ? tenant.mensajeTopeExcedido?.trim() || textoCliente(tenant, "topeExcedido")
    : textoCliente(tenant, "topeGasto");
  if (primerContacto) salida = `${avisoBot(tenant)}\n\n${salida}`;
  await enviarTexto(tenant, entrante.clienteWa, salida).catch((e) => console.error("[tope-mensual] no se pudo avisar al cliente:", e));
  if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id).catch(() => {});
  await repo
    .guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: salida, creadoEn: new Date().toISOString() })
    .catch(() => {});
  await notificarOperador(
    repo,
    tenant,
    conv,
    estado.excedido
      ? "⚠️ Este negocio alcanzó el tope de conversaciones del mes — el bot dejó de responder, atendé manualmente."
      : `⚠️ Este negocio alcanzó el tope de gasto de IA del mes (USD ${gastoLlm.topeUsd}) — el bot dejó de responder, atendé manualmente.`,
  ).catch(() => {});
  return true;
}

/**
 * En qué intento de la cola durable va este turno (E7). Lo pasa el worker desde la
 * fila de wa_jobs (`intentos` ya incrementado por el claim, `max_intentos`).
 */
export interface IntentoJob {
  numero: number;
  max: number;
}

/**
 * E7: ¿relanzar este error para que la cola reintente el job con backoff, en vez de
 * disculparse con el cliente? Solo si es transitorio (429/5xx/red de OpenAI o Graph,
 * ver src/red/transitorio.ts) y al job le queda al menos un intento más. En el ÚLTIMO
 * intento —o sin cola (modo memoria / `manejarWebhook`: `intento` ausente)— se cae al
 * camino de siempre: disculpa + aviso al operador, y el job termina "hecho".
 */
function reintentarMasTarde(e: unknown, intento: IntentoJob | undefined): boolean {
  if (!intento || intento.numero >= intento.max || !esErrorTransitorio(e)) return false;
  console.warn(`[reintento] error transitorio (intento ${intento.numero}/${intento.max}), la cola reintenta con backoff:`, String(e));
  return true;
}

/**
 * FASE 2 — puede tardar (llama al LLM y a la API de WhatsApp). Se ejecuta DESPUÉS
 * de responder 200. El mensaje entrante ya quedó guardado en la fase 1, así que
 * aunque esto falle no se pierde.
 *
 * `db` opcional (F10): lo necesitan los tests de fiabilidad (PGlite) para el
 * enforcement del tope mensual (ver estadoCuotasDelMes); en producción el worker lo pasa.
 *
 * `intento` (E7): lo pasa el worker de la cola. Con él, un error transitorio en el
 * turno del agente LANZA (la cola reintenta) mientras queden intentos — salvo que el
 * turno ya haya tenido efectos que un reintento duplicaría (ver `turnoDelAgente`).
 */
export async function responderEntrante(p: Pendiente, repo: Repositorio, db?: DB, intento?: IntentoJob): Promise<void> {
  switch (p.clase) {
    case "no-texto":
      // Lo que queda sin tipar (video, sticker): pedirle que escriba Y avisar a un humano.
      return responderNoSoportado(p, repo, "multimediaNoSoportada", "📎 Llegó un mensaje multimedia que el bot no puede leer (sticker/video).");
    case "documento":
      return responderNoSoportado(
        p,
        repo,
        "documentoNoSoportado",
        `📄 Llegó un documento que el bot no puede leer: "${p.entrante.documentoNombre ?? "sin nombre"}".`,
      );
    case "contacto":
      return responderNoSoportado(
        p,
        repo,
        "contactoNoSoportado",
        `👤 El cliente compartió un contacto: "${p.entrante.contactoNombre ?? "sin nombre"}".`,
      );
    case "imagen":
      return responderImagen(p, repo, db, intento);
    case "audio":
      return responderAudio(p, repo, db, intento);
    case "texto":
      return responderTexto(p, repo, db, intento);
  }
}

/** Adjunto que el bot no procesa: mensaje específico al cliente + aviso al operador con contexto. */
async function responderNoSoportado(
  p: Extract<Pendiente, { clase: "no-texto" | "documento" | "contacto" }>,
  repo: Repositorio,
  clave: "multimediaNoSoportada" | "documentoNoSoportado" | "contactoNoSoportado",
  avisoOperador: string,
): Promise<void> {
  await enviarTexto(p.tenant, p.entrante.clienteWa, textoCliente(p.tenant, clave)).catch((e) =>
    console.error(`[${p.clase}] no se pudo responder al cliente:`, e),
  );
  await notificarOperador(repo, p.tenant, p.conv, avisoOperador).catch((e) => console.error(`[${p.clase}] notificarOperador:`, e));
}

async function responderImagen(
  p: Extract<Pendiente, { clase: "imagen" }>,
  repo: Repositorio,
  db: DB | undefined,
  intento: IntentoJob | undefined,
): Promise<void> {
  const { tenant, entrante, conv, primerContacto, historialPrevio } = p;
  await reactivarBotSiVencio(repo, tenant, conv, historialPrevio);

  // La foto se descarga YA (antes de mirar el modo): el operador la ve en el panel tanto
  // si la atiende el bot como una persona. `imagenDataUrl` va completo a la visión de
  // OpenAI (C1.5); en la base queda la ruta de Storage (o el data URL si Storage no está
  // configurado, ver storage/supabaseStorage.ts).
  let imagenDataUrl: string | undefined;
  try {
    const { buffer, mimeType } = await descargarMedia(tenant, entrante.imagenId!);
    imagenDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    if (entrante.messageId) {
      const mediaAPersistir = await resolverMediaAPersistir(tenant.id, conv.id, entrante.messageId, buffer, mimeType, imagenDataUrl);
      await repo
        .actualizarMediaMensaje(tenant.id, conv.id, entrante.messageId, mediaAPersistir, "imagen")
        .catch((e) => console.error("[imagen] no se pudo guardar la media en el mensaje:", e));
    }
  } catch (e) {
    if (reintentarMasTarde(e, intento)) throw e;
    console.error("[imagen] no se pudo descargar la foto:", e);
  }

  if (conv.modo === "humano") {
    await notificarOperador(repo, tenant, conv, "📷 Foto recibida.").catch((e) => console.error("[imagen] notificarOperador:", e));
    return;
  }
  if (!imagenDataUrl) {
    // No se pudo bajar la foto: ni silencio con el cliente ni el bot "adivinando" sin verla.
    await enviarTexto(tenant, entrante.clienteWa, textoCliente(tenant, "fotoNoDescargada")).catch(() => {});
    await notificarOperador(repo, tenant, conv, "📷 Foto recibida — no se pudo procesar.").catch(() => {});
    return;
  }

  if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;
  if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

  await turnoDelAgente({
    p,
    repo,
    intento,
    textoUsuario: entrante.imagenCaption?.trim() || TURNO_FOTO_SIN_COMENTARIO,
    imagenDataUrl,
    avisoEscalada: "📷 Foto recibida.",
    etiquetaMotivo: " (foto)",
    detalleEscalada: "escalado a humano (foto)",
    textoError: "errorFoto",
    avisoError: "⚠️ El bot no pudo responder a una foto recibida.",
  });
}

async function responderAudio(
  p: Extract<Pendiente, { clase: "audio" }>,
  repo: Repositorio,
  db: DB | undefined,
  intento: IntentoJob | undefined,
): Promise<void> {
  const { tenant, entrante, conv, primerContacto, historialPrevio } = p;
  await reactivarBotSiVencio(repo, tenant, conv, historialPrevio);

  if (conv.modo === "humano") {
    await notificarOperador(repo, tenant, conv, "🎤 Nota de voz recibida.").catch((e) => console.error("[audio] notificarOperador:", e));
    return;
  }

  // Frenos por cliente ANTES de transcribir: Whisper también se paga.
  if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;

  let transcripcion: string;
  try {
    transcripcion = await transcribirAudio(tenant, entrante.audioId!);
    log.info("audio_transcrito", { tenantId: tenant.id, conversacionId: conv.id, largo: transcripcion.length });
  } catch (e) {
    if (reintentarMasTarde(e, intento)) throw e;
    console.error("[audio] transcripción fallida:", e);
    await enviarTexto(tenant, entrante.clienteWa, textoCliente(tenant, "audioFallido")).catch(() => {});
    await notificarOperador(repo, tenant, conv, "🎤 Nota de voz recibida — transcripción falló.").catch(() => {});
    return;
  }

  // Escotilla de salida: si el audio pide hablar con una persona, se escala sin el agente.
  if (pideHumano(transcripcion)) {
    await traspasarPorPedido(p, repo, `🎤 ${transcripcion}`, "pidió humano (audio)");
    return;
  }
  if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

  await turnoDelAgente({
    p,
    repo,
    intento,
    textoUsuario: transcripcion,
    avisoEscalada: `🎤 ${transcripcion}`,
    etiquetaMotivo: "",
    detalleEscalada: "escalado a humano",
    textoError: "errorGeneral",
    avisoError: `⚠️ El bot no pudo responder a la nota de voz: "${transcripcion.slice(0, 60)}".`,
  });
}

async function responderTexto(
  p: Extract<Pendiente, { clase: "texto" }>,
  repo: Repositorio,
  db: DB | undefined,
  intento: IntentoJob | undefined,
): Promise<void> {
  const { tenant, entrante, conv, primerContacto, historialPrevio } = p;

  // Acciones directas (botones, BAJA): no pasan por el agente ni dependen del modo.
  if (await responderAccionDirecta(p, repo, db)) return;

  // En modo humano el bot NO responde: el mensaje ya quedó guardado, solo se avisa al
  // operador. Salvo que el traspaso haya vencido sin respuesta del equipo (vuelve al bot).
  await reactivarBotSiVencio(repo, tenant, conv, historialPrevio);
  if (conv.modo === "humano") {
    log.info("entrante_en_modo_humano", { tenantId: tenant.id, conversacionId: conv.id });
    await notificarOperador(repo, tenant, conv, entrante.texto).catch((e) => console.error("[humano] notificarOperador:", e));
    return;
  }

  // Escotilla de salida humana: solo con un pedido EXPLÍCITO ("agente", "quiero hablar
  // con una persona"); "¿cuánto es por persona?" no dispara.
  if (pideHumano(entrante.texto)) {
    await traspasarPorPedido(p, repo, entrante.texto, "pidió humano");
    return;
  }

  if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;
  if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

  await turnoDelAgente({
    p,
    repo,
    intento,
    textoUsuario: entrante.texto,
    avisoEscalada: entrante.texto,
    etiquetaMotivo: "",
    detalleEscalada: "escalado a humano",
    textoError: "errorGeneral",
    avisoError: `⚠️ El bot no pudo responder a "${entrante.texto.slice(0, 60)}". Conviene atenderlo a mano.`,
  });
}

/**
 * Acciones directas de la rama de texto (no pasan por el agente ni por el modo humano):
 * confirmación de cita (C1.3), respuesta al seguimiento post-servicio (C3.1/D1.3),
 * consentimiento de marketing y pedido de baja (C3.2). true si el mensaje era una de
 * ellas (ya respondida). La ingesta marca estos mensajes como no agrupables
 * (`esAccionDirecta`): una ráfaga nunca los descarta.
 */
async function responderAccionDirecta(p: Extract<Pendiente, { clase: "texto" }>, repo: Repositorio, db: DB | undefined): Promise<boolean> {
  const { tenant, entrante, conv } = p;
  const responder = async (ack: string) => {
    await enviarTexto(tenant, entrante.clienteWa, ack);
    await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
  };

  // El cliente tocó "Confirmo ✅" en el recordatorio: la cita viaja en el id del botón.
  const citaAConfirmar = esConfirmacionCita(entrante.interactiveId);
  if (citaAConfirmar) {
    try {
      const confirmada = await repo.confirmarCita(tenant.id, citaAConfirmar);
      await responder(textoCliente(tenant, confirmada ? "citaConfirmadaAck" : "graciasGenerico"));
      log.info("cita_confirmacion", { tenantId: tenant.id, conversacionId: conv.id, citaId: citaAConfirmar, confirmada });
    } catch (e) {
      console.error(`[confirmacion] no se pudo confirmar la cita ${citaAConfirmar}:`, e);
    }
    return true;
  }

  // Botón del seguimiento post-servicio: "positivo" pide la reseña de Google, "neutral"
  // agradece sin pedirla (solo Pro), "negativo" escala a una persona antes de que se
  // convierta en una reseña negativa. El registro es no-op para Básico (sin fila).
  const postServicio = respuestaPostServicio(entrante.interactiveId);
  if (postServicio) {
    const { citaId, sentimiento } = postServicio;
    try {
      if (sentimiento === "positivo") {
        await responder(
          tenant.linkResenas
            ? textoCliente(tenant, "postServicioPositivoResena", { link: tenant.linkResenas })
            : textoCliente(tenant, "postServicioPositivo"),
        );
      } else if (sentimiento === "neutral") {
        await responder(textoCliente(tenant, "postServicioNeutral"));
      } else {
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        await responder(textoCliente(tenant, "postServicioNegativo"));
        await notificarOperador(
          repo,
          tenant,
          conv,
          `⚠️ Cliente insatisfecho tras el servicio (cita ${citaId}) — contactalo antes de que quede una reseña negativa.`,
        );
      }
      await repo.registrarRespuestaSeguimiento(tenant.id, citaId, sentimiento, sentimiento === "positivo", entrante.texto);
      log.info("post_servicio_respuesta", { tenantId: tenant.id, conversacionId: conv.id, citaId, sentimiento });
    } catch (e) {
      console.error(`[post-servicio] no se pudo procesar la respuesta de la cita ${citaId}:`, e);
    }
    // El momento menos invasivo para pedir el consentimiento de marketing: tras una buena
    // experiencia. Una sola vez por cliente; best-effort.
    if (sentimiento !== "negativo") {
      await pedirConsentimientoMarketing(tenant, repo, conv, { manual: false, almacen: almacenConsentimiento(db) }).catch((e) =>
        console.error(`[consentimiento] no se pudo ofrecer a ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e),
      );
    }
    return true;
  }

  // "Sí, avísenme" / "No, gracias" del pedido de consentimiento.
  const consentimiento = respuestaConsentimiento(entrante.interactiveId);
  if (consentimiento) {
    try {
      await procesarRespuestaConsentimiento(tenant, repo, conv, consentimiento, almacenConsentimiento(db));
    } catch (e) {
      console.error(`[consentimiento] no se pudo registrar la respuesta de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e);
    }
    return true;
  }

  // Pedido de baja: el mensaje COMPLETO es "baja"/"stop"/… (normalizado, ver
  // esPedidoDeBaja); una palabra suelta dentro de una frase no cuenta. Marca la baja Y
  // retira el consentimiento. Solo frena campañas: recordatorios y post-servicio siguen.
  if (esPedidoDeBaja(entrante.texto)) {
    try {
      await repo.marcarOptOut(tenant.id, conv.id);
      await almacenConsentimiento(db)
        .revocar(tenant.id, entrante.clienteWa)
        .catch((e) =>
          console.error(`[opt-out] no se pudo retirar el consentimiento de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e),
        );
      await responder(textoCliente(tenant, "bajaAck"));
      log.info("opt_out_campanias", { tenantId: tenant.id, conversacionId: conv.id });
    } catch (e) {
      console.error(`[opt-out] no se pudo procesar la baja de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e);
    }
    return true;
  }
  return false;
}

/** El cliente pidió explícitamente una persona: modo humano, aviso al cliente y al operador. */
async function traspasarPorPedido(
  p: Extract<Pendiente, { clase: "texto" | "audio" }>,
  repo: Repositorio,
  avisoOperador: string,
  detalle: string,
): Promise<void> {
  const { tenant, entrante, conv } = p;
  try {
    await repo.setModoConversacion(tenant.id, conv.id, "humano");
    await enviarTexto(tenant, entrante.clienteWa, textoCliente(tenant, "traspasoHumano"));
    await notificarOperador(repo, tenant, conv, avisoOperador);
    await repo.registrarCalidad({ tenantId: tenant.id, clienteWa: entrante.clienteWa, tipo: "fuera_de_alcance", detalle });
  } catch (e) {
    // La conversación ya quedó en humano: se registra el fallo para que el caso no quede
    // mudo (sin confirmación al cliente ni aviso al operador).
    console.error("[humano] no se pudo completar el traspaso:", e);
    await repo
      .registrarCalidad({ tenantId: tenant.id, clienteWa: entrante.clienteWa, tipo: "error", detalle: "fallo en traspaso a humano: " + String(e) })
      .catch(() => {});
  }
}

/** Un turno del agente (texto, audio transcrito o foto) y su salida. */
interface Turno {
  p: Extract<Pendiente, { clase: "texto" | "audio" | "imagen" }>;
  repo: Repositorio;
  intento?: IntentoJob;
  /** Lo que el agente recibe como mensaje del cliente. */
  textoUsuario: string;
  imagenDataUrl?: string;
  /** Aviso al operador si el agente escala SIN motivo. */
  avisoEscalada: string;
  /** Va en el aviso con motivo: "🙋 El bot pasó este caso{etiqueta}: {motivo}". */
  etiquetaMotivo: string;
  /** Detalle del evento de calidad si escala sin motivo. */
  detalleEscalada: string;
  /** Texto al cliente y aviso al operador si el turno falla del todo. */
  textoError: "errorGeneral" | "errorFoto";
  avisoError: string;
}

/**
 * Corre el agente con el historial fresco y entrega su salida: respuesta (texto o
 * interactivo), o traspaso a humano si el agente escaló.
 *
 * E7: un error transitorio (OpenAI 429/5xx/timeout, Graph caído) relanza para que la cola
 * reintente el turno ENTERO con backoff — pero solo mientras el turno no dejó efectos que
 * un reintento repetiría: una acción de agenda ya guardada (`confirmacion`: re-correr el
 * agente duplicaría la cita), el traspaso aplicado o la respuesta ya enviada.
 */
async function turnoDelAgente(t: Turno): Promise<void> {
  const { p, repo } = t;
  const { tenant, entrante, conv, primerContacto, historialPrevio: snapshot } = p;
  const base = { tenantId: tenant.id, conversacionId: conv.id, clase: p.clase, correlationId: p.correlationId };
  let reintentable = true;
  try {
    const historial = await historialFresco(repo, tenant, conv, entrante.messageId, snapshot);
    const r = await correrAgente({ tenant, repo, clienteWa: entrante.clienteWa }, t.textoUsuario, historial, t.imagenDataUrl);
    if (r.confirmacion) reintentable = false;

    // Mientras el LLM pensaba, un humano pudo tomar la conversación desde el panel: se
    // revalida el modo (lectura liviana) ANTES de hablar para no pisar a la persona.
    if ((await repo.obtenerModo(tenant.id, conv.id)) === "humano") {
      log.info("respuesta_descartada", { ...base, motivo: "humano_tomo_la_conversacion" });
      return;
    }

    const conAviso = (texto: string) => (primerContacto ? `${avisoBot(tenant)}\n\n${texto}` : texto);
    const ahora = () => new Date().toISOString();

    if (r.escalar) {
      // El bot no pudo resolver: pasa a una persona en vez de responder algo vago.
      reintentable = false;
      await repo.setModoConversacion(tenant.id, conv.id, "humano");
      const aviso = textoEscalada(tenant, r.confirmacion);
      await enviarTexto(tenant, entrante.clienteWa, conAviso(aviso));
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: aviso, creadoEn: ahora() });
      await notificarOperador(repo, tenant, conv, r.motivo ? `🙋 El bot pasó este caso${t.etiquetaMotivo}: ${r.motivo}` : t.avisoEscalada);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: "fuera_de_alcance",
        detalle: r.motivo ? `escalado: ${r.motivo}` : t.detalleEscalada,
      });
      log.info("escalado_a_humano", { ...base, conMotivo: !!r.motivo });
      return;
    }

    // Enviar PRIMERO y persistir DESPUÉS: si el envío falla no queda en el historial un
    // mensaje que el cliente nunca recibió (y el aviso de bot se reintenta la próxima).
    await enviarRespuestaBot(tenant, entrante.clienteWa, conAviso(r.respuesta), r.interactivo);
    reintentable = false;
    if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
    await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: r.respuesta, creadoEn: ahora() });
    log.info("respuesta_enviada", { ...base, fueraDeAlcance: r.fueraDeAlcance, largo: r.respuesta.length });
    await repo.registrarCalidad({
      tenantId: tenant.id,
      clienteWa: entrante.clienteWa,
      tipo: r.fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
    });
  } catch (e) {
    // Quedan intentos y el error es transitorio: sin disculpa ni aviso todavía.
    if (reintentable && reintentarMasTarde(e, t.intento)) throw e;
    console.error(`[${p.clase}] error procesando el turno:`, e);
    await repo
      .registrarCalidad({ tenantId: tenant.id, clienteWa: entrante.clienteWa, tipo: "error", detalle: String(e) })
      .catch(() => {});
    await enviarTexto(tenant, entrante.clienteWa, textoCliente(tenant, t.textoError)).catch(() => {});
    // Red de seguridad: si el envío de arriba también falló (WhatsApp caído), el cliente
    // quedó sin respuesta; un humano tiene que enterarse ya.
    await notificarOperador(repo, tenant, conv, t.avisoError).catch((e2) => console.error("[webhook] notificarOperador tras error:", e2));
  }
}

/**
 * Orquesta las dos fases en una sola llamada (cómodo para tests). El server las
 * llama por separado para responder 200 recién después de persistir el entrante.
 */
export async function manejarWebhook(body: unknown, repo: Repositorio, db?: DB): Promise<void> {
  for (const parte of separarPayloadWebhook(body)) {
    const pendiente = await ingerirEntrante(parte, repo, db);
    if (pendiente) await responderEntrante(pendiente, repo);
  }
}
