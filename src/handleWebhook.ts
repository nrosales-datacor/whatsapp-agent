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
  ACK_BAJA,
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

// Aviso de transparencia que se manda UNA vez por cliente (cumple opt-in/política).
const AVISO_BOT =
  "👋 ¡Hola! Soy el asistente automatizado de %NOMBRE%. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.";

// Mensaje al cliente cuando el bot no pudo resolver y pasa el caso a una persona.
const MENSAJE_ESCALADA = "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.";
/**
 * Aviso de traspaso. Si en el mismo turno ya quedó guardada una cita (agendada,
 * reprogramada o cancelada), se confirma PRIMERO con texto fijo: el cliente no debe
 * creer que no agendó y reintentar (revisión pre-venta 2026-10).
 */
function textoEscalada(confirmacion?: string): string {
  return confirmacion ? `${confirmacion}\n\n${MENSAJE_ESCALADA}` : MENSAJE_ESCALADA;
}

// F10 (PLAN-ESCALA-MULTITENANT.md): mensaje al cliente cuando el negocio alcanzó el
// 100% del tope mensual de conversaciones de su plan. Default razonable; el dueño
// puede personalizarlo (tenant.mensajeTopeExcedido, "Mi negocio" → panel).
const MENSAJE_TOPE_EXCEDIDO = "¡Gracias por escribirnos! 🙌 En un momento te atiende alguien del equipo.";

// Tope mensual de GASTO de LLM (revisión pre-venta 2026-10): texto neutro a
// propósito — es una red de seguridad interna, no algo que el cliente final deba
// leer como "se acabó el servicio".
const MENSAJE_TOPE_GASTO = "¡Gracias por escribirnos! 🙂 En un momento te atiende una persona del equipo por acá.";

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
      conv,
      correlationId,
      ...(esAudio || esImagen ? { primerContacto, historialPrevio } : {}),
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
  const payload: PendienteSerializado = {
    clase: "texto",
    tenantId: tenant.id,
    entrante,
    conv,
    primerContacto,
    historialPrevio,
    correlationId,
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
 * texto neutro (MENSAJE_TOPE_GASTO) y su propio aviso al operador.
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
  let salida = estado.excedido ? tenant.mensajeTopeExcedido?.trim() || MENSAJE_TOPE_EXCEDIDO : MENSAJE_TOPE_GASTO;
  if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
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
 * `db` opcional (F10): solo lo necesitan los tests de fiabilidad (PGlite) para el
 * enforcement del tope mensual (ver estadoCuotasDelMes) — en producción no hace
 * falta pasarlo, el pool singleton ya resuelve solo con DATABASE_URL.
 *
 * `intento` (E7): lo pasa el worker de la cola. Con él, un error transitorio en el
 * turno del agente LANZA (la cola reintenta) mientras queden intentos — salvo que el
 * turno ya haya tenido efectos que un reintento duplicaría (ver `reintentable`).
 */
export async function responderEntrante(p: Pendiente, repo: Repositorio, db?: DB, intento?: IntentoJob): Promise<void> {
  if (p.clase === "no-texto") {
    // Lo que queda sin tipar tras E12: video y sticker (las fotos las procesa la
    // rama "imagen" de abajo, C1.5; documento/contacto/reacción/ubicación tienen su
    // propio manejo — ver las ramas de abajo y parsearEntrante). Le pedimos al
    // cliente que escriba en qué ayudarle Y avisamos a un humano: el adjunto puede
    // ser importante y no queremos ignorarlo.
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

  if (p.clase === "documento") {
    // El bot no procesa documentos todavía (E12): a diferencia del genérico de
    // stickers/video, acá SÍ reconocemos que llegó un documento (no un adjunto
    // ilegible cualquiera) y le pasamos el nombre de archivo al operador para que
    // sepa qué llegó sin tener que adivinar.
    const nombreArchivo = p.entrante.documentoNombre ?? "sin nombre";
    await enviarTexto(
      p.tenant,
      p.entrante.clienteWa,
      "¡Hola! 🙂 Recibí tu documento, pero todavía no puedo abrirlo. Contame por texto en qué te ayudo y si hace falta alguien del equipo lo revisa.",
    ).catch((e) => console.error("[documento] no se pudo responder al cliente:", e));
    await notificarOperador(
      repo,
      p.tenant,
      p.conv,
      `📄 Llegó un documento que el bot no puede leer: "${nombreArchivo}".`,
    ).catch((e) => console.error("[documento] notificarOperador:", e));
    return;
  }

  if (p.clase === "contacto") {
    // Mismo criterio que "documento": mensaje específico (no el genérico) + push
    // con el nombre del contacto compartido, para que el operador no tenga que adivinar.
    const nombreContacto = p.entrante.contactoNombre ?? "sin nombre";
    await enviarTexto(
      p.tenant,
      p.entrante.clienteWa,
      "¡Hola! 🙂 Recibí el contacto que compartiste, pero todavía no puedo procesarlo. Contame por texto en qué te ayudo.",
    ).catch((e) => console.error("[contacto] no se pudo responder al cliente:", e));
    await notificarOperador(
      repo,
      p.tenant,
      p.conv,
      `👤 El cliente compartió un contacto: "${nombreContacto}".`,
    ).catch((e) => console.error("[contacto] notificarOperador:", e));
    return;
  }

  if (p.clase === "imagen") {
    const { tenant, entrante, conv, primerContacto, historialPrevio: historialSnapshot } = p;
    await reactivarBotSiVencio(repo, tenant, conv, historialSnapshot);

    // Descargamos la foto YA (antes de mirar el modo): así el operador la ve en el
    // panel tanto si la atiende el bot como si la atiende una persona.
    //
    // `imagenDataUrl` (en memoria, NUNCA persistido así) sigue viajando completo a
    // la visión de OpenAI (C1.5) — eso no cambia (F9). Lo que SÍ cambia es qué se
    // guarda en `wa_mensajes.media_url`: si Supabase Storage está configurado, el
    // binario se sube ahí y en la columna queda solo la ruta corta del objeto; si
    // no, cae al comportamiento previo (persistir el data URL completo), ver
    // `storage/supabaseStorage.ts`.
    let imagenDataUrl: string | undefined;
    try {
      const { buffer, mimeType } = await descargarMedia(tenant, entrante.imagenId!);
      imagenDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      if (entrante.messageId) {
        const mediaAPersistir = await resolverMediaAPersistir(
          tenant.id,
          conv.id,
          entrante.messageId,
          buffer,
          mimeType,
          imagenDataUrl,
        );
        await repo
          .actualizarMediaMensaje(tenant.id, conv.id, entrante.messageId, mediaAPersistir, "imagen")
          .catch((e) => console.error("[imagen] no se pudo guardar la media en el mensaje:", e));
      }
    } catch (e) {
      if (reintentarMasTarde(e, intento)) throw e;
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

    if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;
    if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

    // E7: mismo criterio que la rama de texto (ver el comentario de `reintentable` ahí).
    let reintentable = true;
    try {
      const historialPrevio = await historialFresco(repo, tenant, conv, entrante.messageId, historialSnapshot);
      const { respuesta, fueraDeAlcance, escalar, motivo, interactivo, confirmacion } = await correrAgente(
        { tenant, repo, clienteWa: entrante.clienteWa },
        entrante.imagenCaption?.trim() || "El cliente mandó esta foto sin comentario. Mirala y ayudalo.",
        historialPrevio,
        imagenDataUrl,
      );
      if (confirmacion) reintentable = false;

      const modoActual = await repo.obtenerModo(tenant.id, conv.id);
      if (modoActual === "humano") {
        log.info("respuesta_descartada", { tenantId: tenant.id, conversacionId: conv.id, clase: "imagen", motivo: "humano_tomo_la_conversacion" });
        return;
      }

      if (escalar) {
        reintentable = false;
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        let salida = textoEscalada(confirmacion);
        if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
        await enviarTexto(tenant, entrante.clienteWa, salida);
        if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: textoEscalada(confirmacion), creadoEn: new Date().toISOString() });
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
      reintentable = false;
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: respuesta, creadoEn: new Date().toISOString() });
      log.info("respuesta_enviada", { tenantId: tenant.id, conversacionId: conv.id, clase: "imagen", largo: respuesta.length });
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
      });
    } catch (e) {
      if (reintentable && reintentarMasTarde(e, intento)) throw e;
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
    const { tenant, entrante, conv, primerContacto, historialPrevio: historialSnapshot } = p;
    await reactivarBotSiVencio(repo, tenant, conv, historialSnapshot);

    if (conv.modo === "humano") {
      await notificarOperador(repo, tenant, conv, "🎤 Nota de voz recibida.").catch((e) =>
        console.error("[audio] notificarOperador:", e),
      );
      return;
    }

    // Frenos por cliente ANTES de transcribir: Whisper también se paga.
    if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;

    let textoTranscrito: string;
    try {
      textoTranscrito = await transcribirAudio(tenant, entrante.audioId!);
      log.info("audio_transcrito", { tenantId: tenant.id, conversacionId: conv.id, largo: textoTranscrito.length });
    } catch (e) {
      if (reintentarMasTarde(e, intento)) throw e;
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
    if (pideHumano(textoTranscrito)) {
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

    if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

    // E7: mismo criterio que la rama de texto (ver el comentario de `reintentable` ahí).
    let reintentable = true;
    try {
      const historialPrevio = await historialFresco(repo, tenant, conv, entrante.messageId, historialSnapshot);
      const { respuesta, fueraDeAlcance, escalar, motivo, interactivo, confirmacion } = await correrAgente(
        { tenant, repo, clienteWa: entrante.clienteWa },
        textoTranscrito,
        historialPrevio,
      );
      if (confirmacion) reintentable = false;

      const modoActual = await repo.obtenerModo(tenant.id, conv.id);
      if (modoActual === "humano") {
        log.info("respuesta_descartada", { tenantId: tenant.id, conversacionId: conv.id, clase: "audio", motivo: "humano_tomo_la_conversacion" });
        return;
      }

      if (escalar) {
        reintentable = false;
        await repo.setModoConversacion(tenant.id, conv.id, "humano");
        let salida = textoEscalada(confirmacion);
        if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
        await enviarTexto(tenant, entrante.clienteWa, salida);
        if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
        await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: textoEscalada(confirmacion), creadoEn: new Date().toISOString() });
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
      reintentable = false;
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: respuesta, creadoEn: new Date().toISOString() });
      log.info("respuesta_enviada", { tenantId: tenant.id, conversacionId: conv.id, clase: "audio", largo: respuesta.length });
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
      });
    } catch (e) {
      if (reintentable && reintentarMasTarde(e, intento)) throw e;
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

  const { tenant, entrante, conv, primerContacto, historialPrevio: historialSnapshot, correlationId } = p;

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
      log.info("cita_confirmacion", { tenantId: tenant.id, conversacionId: conv.id, citaId: citaAConfirmar, confirmada });
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
      log.info("post_servicio_respuesta", { tenantId: tenant.id, conversacionId: conv.id, citaId, sentimiento });
    } catch (e) {
      console.error(`[post-servicio] no se pudo procesar la respuesta de la cita ${citaId}:`, e);
    }
    // Consentimiento de marketing: el punto menos invasivo para preguntarlo es acá,
    // tras una buena experiencia con una cita ya hecha (ver campaigns/consentimiento.ts).
    // Una sola vez por cliente; best-effort (nunca rompe el seguimiento).
    if (sentimiento !== "negativo") {
      await pedirConsentimientoMarketing(tenant, repo, conv, { manual: false, almacen: almacenConsentimiento(db) }).catch(
        (e) => console.error(`[consentimiento] no se pudo ofrecer a ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e),
      );
    }
    return;
  }

  // CONSENTIMIENTO DE MARKETING: el cliente tocó "Sí, avísenme" / "No, gracias".
  // Acción directa (no pasa por el agente ni depende del modo humano/bot).
  const consentimiento = respuestaConsentimiento(entrante.interactiveId);
  if (consentimiento) {
    try {
      await procesarRespuestaConsentimiento(tenant, repo, conv, consentimiento, almacenConsentimiento(db));
    } catch (e) {
      console.error(`[consentimiento] no se pudo registrar la respuesta de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e);
    }
    return;
  }

  // OPT-OUT DE CAMPAÑAS (C3.2): el mensaje COMPLETO es un pedido de baja ("baja",
  // "BAJA.", "stop", "cancelar suscripción", "no me manden más"… normalizado, ver
  // esPedidoDeBaja); una palabra suelta dentro de una frase no cuenta ("quiero
  // cancelar mi cita" no es baja). Es acción directa: no pasa por el agente ni
  // depende del modo (humano/bot) — un cliente puede pedir baja aunque lo esté
  // atendiendo una persona. Marca la baja Y retira el consentimiento de marketing.
  // Detiene SOLO campañas de marketing; los recordatorios y el seguimiento
  // post-servicio siguen llegando (son mensajes de servicio, no marketing, ligados
  // a una cita que el cliente ya agendó).
  if (esPedidoDeBaja(entrante.texto)) {
    try {
      await repo.marcarOptOut(tenant.id, conv.id);
      await almacenConsentimiento(db)
        .revocar(tenant.id, entrante.clienteWa)
        .catch((e) => console.error(`[opt-out] no se pudo retirar el consentimiento de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e));
      const ack = ACK_BAJA;
      await enviarTexto(tenant, entrante.clienteWa, ack);
      await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
      log.info("opt_out_campanias", { tenantId: tenant.id, conversacionId: conv.id });
    } catch (e) {
      console.error(`[opt-out] no se pudo procesar la baja de ${enmascararTelefono(entrante.clienteWa)} (tenant ${tenant.id}):`, e);
    }
    return;
  }

  // Si la conversación YA está en modo humano, el bot NO responde: el mensaje ya
  // quedó guardado; solo avisamos al operador para que conteste del panel. Salvo
  // que el traspaso haya vencido sin respuesta del equipo (vuelve al bot).
  await reactivarBotSiVencio(repo, tenant, conv, historialSnapshot);
  if (conv.modo === "humano") {
    log.info("entrante_en_modo_humano", { tenantId: tenant.id, conversacionId: conv.id });
    await notificarOperador(repo, tenant, conv, entrante.texto).catch((e) =>
      console.error("[humano] notificarOperador:", e),
    );
    return;
  }

  // Escotilla de salida humana: solo con un pedido EXPLÍCITO ("agente", "quiero
  // hablar con una persona"); "¿cuánto es por persona?" ya no dispara.
  if (pideHumano(entrante.texto)) {
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

  if (await aplicarFrenosPorCliente({ tenant, repo, conv, clienteWa: entrante.clienteWa, db })) return;
  if (await aplicarTopeMensualSiCorresponde(tenant, repo, entrante, conv, primerContacto, db)) return;

  // E7: un error transitorio (OpenAI 429/5xx/timeout, Graph caído) relanza para que la
  // cola reintente el turno ENTERO con backoff — pero solo mientras el turno no haya
  // dejado efectos que un reintento repetiría: una acción de agenda ya guardada
  // (`confirmacion`, red de seguridad G5 de runAgent: re-correr el agente volvería a
  // llamar a `agendar_cita` y duplicaría la cita), el traspaso a humano ya aplicado o
  // la respuesta ya enviada. Pasado ese punto, el fallo se maneja como siempre.
  let reintentable = true;
  try {
    const historialPrevio = await historialFresco(repo, tenant, conv, entrante.messageId, historialSnapshot);
    const { respuesta, fueraDeAlcance, escalar, motivo, interactivo, confirmacion } = await correrAgente(
      { tenant, repo, clienteWa: entrante.clienteWa },
      entrante.texto,
      historialPrevio,
    );
    if (confirmacion) reintentable = false;

    // Mientras el LLM pensaba, un humano pudo tomar la conversación desde el panel.
    // Revalidamos el modo (lectura liviana) ANTES de hablar para no pisar a la persona.
    const modoActual = await repo.obtenerModo(tenant.id, conv.id);
    if (modoActual === "humano") {
      log.info("respuesta_descartada", { tenantId: tenant.id, conversacionId: conv.id, clase: "texto", motivo: "humano_tomo_la_conversacion" });
      return;
    }

    // El bot no pudo resolver (pidió escalar_a_humano o se trabó): pasamos la conversación
    // a una persona y avisamos (push), en vez de mandar una respuesta vaga o genérica.
    if (escalar) {
      reintentable = false;
      await repo.setModoConversacion(tenant.id, conv.id, "humano");
      let salida = textoEscalada(confirmacion);
      if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${salida}`;
      await enviarTexto(tenant, entrante.clienteWa, salida);
      if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
      await repo.guardarMensaje(tenant.id, conv.id, {
        rol: "assistant",
        contenido: textoEscalada(confirmacion),
        creadoEn: new Date().toISOString(),
      });
      await notificarOperador(repo, tenant, conv, motivo ? `🙋 El bot pasó este caso: ${motivo}` : entrante.texto);
      await repo.registrarCalidad({
        tenantId: tenant.id,
        clienteWa: entrante.clienteWa,
        tipo: "fuera_de_alcance",
        detalle: motivo ? `escalado: ${motivo}` : "escalado a humano",
      });
      log.info("escalado_a_humano", { tenantId: tenant.id, conversacionId: conv.id, conMotivo: !!motivo });
      return;
    }

    // En el primer contacto, anteponer el aviso de bot (transparencia + opt-in).
    let salida = respuesta;
    if (primerContacto) salida = `${AVISO_BOT.replace("%NOMBRE%", tenant.nombre)}\n\n${respuesta}`;

    // Enviar PRIMERO y persistir DESPUÉS: si el envío falla, no queda un mensaje
    // "fantasma" en el historial que el cliente nunca recibió (y el opt-in no se
    // marca, así el aviso se reintenta en el próximo mensaje).
    await enviarRespuestaBot(tenant, entrante.clienteWa, salida, interactivo);
    reintentable = false;
    if (primerContacto) await repo.marcarOptIn(tenant.id, conv.id);
    await repo.guardarMensaje(tenant.id, conv.id, {
      rol: "assistant",
      contenido: respuesta,
      creadoEn: new Date().toISOString(),
    });
    log.info("respuesta_enviada", { correlationId, tenantId: tenant.id, conversacionId: conv.id, fueraDeAlcance, largo: respuesta.length });

    await repo.registrarCalidad({
      tenantId: tenant.id,
      clienteWa: entrante.clienteWa,
      tipo: fueraDeAlcance ? "fuera_de_alcance" : "mensaje_ok",
    });
  } catch (e) {
    // Quedan intentos y el error es transitorio: sin disculpa ni aviso al operador
    // todavía — eso es solo para el último intento (o para errores permanentes).
    if (reintentable && reintentarMasTarde(e, intento)) throw e;
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
export async function manejarWebhook(body: unknown, repo: Repositorio, db?: DB): Promise<void> {
  for (const parte of separarPayloadWebhook(body)) {
    const pendiente = await ingerirEntrante(parte, repo, db);
    if (pendiente) await responderEntrante(pendiente, repo);
  }
}
