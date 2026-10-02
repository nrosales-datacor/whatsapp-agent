import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema, waMensajes } from "../db/schema";
import type { Conversacion, Repositorio, Tenant } from "../types";
import { enviarTexto } from "../whatsapp/client";
import { notificarOperador } from "../panel/notificaciones";
import { log } from "../observabilidad/log";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Frenos de costo POR CLIENTE FINAL (revisión pre-venta 2026-10).
//
// POR QUÉ: los topes que ya existían no frenan a UN cliente que se desboca. El de
// conversaciones (observabilidad/cuotas.ts) cuenta ventanas de 24 h, así que un
// spammer — o un bucle con el autorespondedor de otro negocio — cuenta como UNA
// conversación aunque genere miles de turnos; y el rate limit de ingesta
// (limiteIngesta.ts) es por tenant y solo atrasa el mensaje unos segundos. Cada
// turno son hasta 4 llamadas pagadas al modelo.
//
// Dos frenos, en este orden:
//   1) BUCLE BOT-A-BOT: el mismo texto entrante repetido muchas veces en pocos
//      minutos (típico de un autorespondedor que contesta cada respuesta nuestra).
//      Se pausa el bot en ESA conversación (modo humano) y se avisa al operador.
//      Al cliente NO se le manda nada: cualquier mensaje nuestro alimentaría el
//      bucle. El modo humano vence solo (MODO_HUMANO_VENCE_HORAS, traspasoHumano.ts);
//      si el bucle sigue, se vuelve a detectar antes de la primera llamada al LLM.
//   2) LÍMITE POR HORA: máximo de turnos del agente por cliente en la última hora
//      (ventana deslizante). Al pasarlo: no se llama al LLM, se le avisa UNA vez al
//      cliente con un texto neutro y se notifica al operador UNA vez. El modo no
//      cambia: el equipo puede contestar desde el panel, y cuando la ventana se
//      libera el bot retoma solo.
//
// DÓNDE SE APLICA: al RESPONDER (fase 2, `responderEntrante`), justo antes de la
// llamada al LLM, y no en la ingesta. Razones:
//   • es el punto exacto donde se gasta la plata; las acciones directas sin LLM
//     (botón "Confirmo", "BAJA", pedir una persona, modo humano) siguen funcionando
//     aunque el cliente esté frenado;
//   • se cuentan TURNOS DEL BOT (respuestas guardadas), no mensajes recibidos: los
//     mensajes de una ráfaga que el coalescing de la cola (E5) descartó nunca
//     llegaron al LLM y no deben consumir el cupo del cliente;
//   • la ingesta corre ANTES del 200 a Meta: tiene que ser rápida y no puede mandar
//     mensajes (el aviso al cliente es trabajo de fase 2).
//
// ESTADO: todo sale de `wa_mensajes` (Postgres), no de memoria, así que funciona
// igual con N réplicas `worker` y sin migración. El "avisar UNA sola vez" usa el
// índice único de `wa_message_id` como reclamo atómico: el aviso se guarda con un
// id sintético por conversación y por hora (`freno-cliente:<convId>:<hora>`), y
// solo la réplica cuyo INSERT entra (guardarMensaje → true) manda el aviso y
// notifica. Además, si ya hubo un aviso en la última hora, ni se intenta.
// ─────────────────────────────────────────────────────────────────────────────

/** Prefijo del `waMessageId` sintético del aviso (los de Meta empiezan con "wamid."). */
export const PREFIJO_AVISO_LIMITE = "freno-cliente:";

/** Texto neutro al cliente al pasar el límite por hora (no menciona límites ni costos). */
export const MENSAJE_LIMITE_CLIENTE =
  "Recibimos varios mensajes tuyos seguidos 🙏 Una persona del equipo va a revisar la conversación y te responde por acá en cuanto pueda.";

const HORA_MS = 60 * 60 * 1000;

function enteroDeEnv(nombre: string, porDefecto: number): number {
  const crudo = process.env[nombre];
  const n = crudo !== undefined && crudo !== "" ? Number(crudo) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : porDefecto;
}

/** Turnos del agente por cliente por hora. 0 = freno desactivado. Se lee en cada llamada (tests). */
export function limiteTurnosPorHora(): number {
  return enteroDeEnv("LIMITE_CLIENTE_MENSAJES_HORA", 30);
}

/** Ventana (minutos) en la que se buscan mensajes entrantes repetidos. */
function ventanaBucleMin(): number {
  return Math.max(1, enteroDeEnv("BUCLE_VENTANA_MIN", 10));
}

/**
 * Cuántas veces tiene que llegar el MISMO texto dentro de la ventana para tratarlo
 * como bucle. 0 = detección desactivada. Piso de 4 aunque se configure menos: una
 * ráfaga humana normal (2-3 mensajes seguidos, incluso "hola" "hola" "hola") nunca
 * debe pausar el bot.
 */
function repeticionesBucle(): number {
  const n = enteroDeEnv("BUCLE_REPETICIONES", 5);
  return n === 0 ? 0 : Math.max(4, n);
}

/**
 * Normaliza un texto para comparar repeticiones: minúsculas, sin tildes, espacios
 * colapsados y los números reemplazados por "#" (muchos autorespondedores meten un
 * número de ticket o la hora: "Ticket #1234 recibido" ≈ "Ticket #1235 recibido").
 */
export function normalizarParaBucle(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EntranteReciente {
  contenido: string;
  creadoEn: Date;
}

/**
 * Cálculo puro: ¿los mensajes entrantes de la ventana parecen un bucle con otro
 * bot? Devuelve el texto repetido y cuántas veces llegó, o null. Los marcadores de
 * multimedia ("[foto]", "[audio]", "[documento] …") NO cuentan: un álbum de 10
 * fotos o varias notas de voz seguidas son uso humano normal y se guardan con el
 * mismo marcador.
 */
export function detectarBucle(
  entrantes: EntranteReciente[],
  repeticionesMin: number,
): { texto: string; repeticiones: number } | null {
  if (repeticionesMin <= 0) return null;
  const cuenta = new Map<string, number>();
  for (const m of entrantes) {
    if (m.contenido.trim().startsWith("[")) continue;
    const clave = normalizarParaBucle(m.contenido);
    if (!clave) continue;
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  let peor: { texto: string; repeticiones: number } | null = null;
  for (const [texto, repeticiones] of cuenta) {
    if (repeticiones >= repeticionesMin && (!peor || repeticiones > peor.repeticiones)) peor = { texto, repeticiones };
  }
  return peor;
}

export interface ActividadCliente {
  /** Respuestas del bot (no de un operador, no avisos de freno) en la última hora. */
  turnosBotUltimaHora: number;
  /** true si ya se le mandó el aviso de límite en la última hora. */
  avisoUltimaHora: boolean;
  /** Mensajes del cliente dentro de la ventana de detección de bucle. */
  entrantesRecientes: EntranteReciente[];
}

/** Con DB: dos consultas chicas sobre `wa_mensajes` (índice por conversación). */
async function leerActividadDb(db: DB, conversacionId: string, ahora: number): Promise<ActividadCliente> {
  const haceUnaHora = new Date(ahora - HORA_MS);
  const [fila] = await db
    .select({
      turnos: sql<number>`count(*) filter (where ${waMensajes.rol} = 'assistant' and ${waMensajes.porHumano} = false and ${waMensajes.waMessageId} is null)`.mapWith(Number),
      avisos: sql<number>`count(*) filter (where ${waMensajes.waMessageId} like ${PREFIJO_AVISO_LIMITE + "%"})`.mapWith(Number),
    })
    .from(waMensajes)
    .where(and(eq(waMensajes.conversacionId, conversacionId), gt(waMensajes.creadoEn, haceUnaHora)));
  const entrantes = await db
    .select({ contenido: waMensajes.contenido, creadoEn: waMensajes.creadoEn })
    .from(waMensajes)
    .where(
      and(
        eq(waMensajes.conversacionId, conversacionId),
        eq(waMensajes.rol, "user"),
        gt(waMensajes.creadoEn, new Date(ahora - ventanaBucleMin() * 60_000)),
      ),
    )
    .orderBy(desc(waMensajes.creadoEn))
    .limit(100);
  return {
    turnosBotUltimaHora: fila?.turnos ?? 0,
    avisoUltimaHora: (fila?.avisos ?? 0) > 0,
    entrantesRecientes: entrantes,
  };
}

/** Sin DB (dev local / repositorio en memoria): mismo cálculo sobre la conversación del repo. */
async function leerActividadRepo(
  repo: Repositorio,
  tenantId: string,
  conversacionId: string,
  ahora: number,
): Promise<ActividadCliente> {
  const conv = await repo.obtenerConversacionPorId(tenantId, conversacionId);
  const mensajes = conv?.mensajes ?? [];
  const desdeHora = ahora - HORA_MS;
  const desdeBucle = ahora - ventanaBucleMin() * 60_000;
  const ms = (iso: string) => Date.parse(iso);
  const ultimaHora = mensajes.filter((m) => ms(m.creadoEn) > desdeHora);
  return {
    turnosBotUltimaHora: ultimaHora.filter((m) => m.rol === "assistant" && !m.porHumano && !m.waMessageId).length,
    avisoUltimaHora: ultimaHora.some((m) => m.waMessageId?.startsWith(PREFIJO_AVISO_LIMITE)),
    entrantesRecientes: mensajes
      .filter((m) => m.rol === "user" && ms(m.creadoEn) > desdeBucle)
      .map((m) => ({ contenido: m.contenido, creadoEn: new Date(m.creadoEn) })),
  };
}

export interface FrenoClienteArgs {
  tenant: Tenant;
  repo: Repositorio;
  conv: Conversacion;
  clienteWa: string;
  /** Como en `responderEntrante`: el worker lo pasa siempre; sin él se lee del repositorio. */
  db?: DB;
  /** Solo para tests. */
  ahora?: Date;
}

/**
 * Corre los dos frenos por cliente antes de llamar al LLM. Devuelve `true` si el
 * caller NO debe llamar al agente (bucle pausado o límite por hora alcanzado).
 *
 * Fail-open: si la lectura de actividad falla, se deja pasar el turno (devuelve
 * false) — el cliente no se queda sin respuesta por un error de lectura, y el tope
 * mensual de gasto del tenant sigue protegiendo el costo.
 */
export async function aplicarFrenosPorCliente(a: FrenoClienteArgs): Promise<boolean> {
  const { tenant, repo, conv, clienteWa, db } = a;
  const limite = limiteTurnosPorHora();
  const repeticiones = repeticionesBucle();
  if (limite === 0 && repeticiones === 0) return false;

  const ahora = (a.ahora ?? new Date()).getTime();
  let actividad: ActividadCliente;
  try {
    actividad = db ? await leerActividadDb(db, conv.id, ahora) : await leerActividadRepo(repo, tenant.id, conv.id, ahora);
  } catch (e) {
    console.error("[freno-cliente] no se pudo leer la actividad reciente, se deja pasar el turno:", e);
    return false;
  }

  // 1) Bucle bot-a-bot.
  const bucle = detectarBucle(actividad.entrantesRecientes, repeticiones);
  if (bucle) {
    log.warn("bucle_bot_detectado", {
      tenantId: tenant.id,
      conversacionId: conv.id,
      repeticiones: bucle.repeticiones,
      ventanaMin: ventanaBucleMin(),
    });
    await repo.setModoConversacion(tenant.id, conv.id, "humano");
    conv.modo = "humano";
    await notificarOperador(
      repo,
      tenant,
      conv,
      `🔁 Posible bucle con otro bot (el mismo mensaje llegó ${bucle.repeticiones} veces en ${ventanaBucleMin()} min). Pausamos el bot en esta conversación: revisala y respondé a mano si es un cliente real.`,
    ).catch((e) => console.error("[freno-cliente] notificarOperador (bucle):", e));
    await repo
      .registrarCalidad({ tenantId: tenant.id, clienteWa, tipo: "fuera_de_alcance", detalle: "bucle con otro bot: bot pausado" })
      .catch(() => {});
    return true;
  }

  // 2) Límite de turnos por hora.
  if (limite === 0 || actividad.turnosBotUltimaHora < limite) return false;
  if (actividad.avisoUltimaHora) return true; // ya se avisó: silencio (el mensaje igual quedó guardado para el panel)

  // Reclamo atómico del aviso (ver cabecera). El aviso se PERSISTE antes de
  // enviarlo — al revés que una respuesta normal — porque el INSERT es el candado
  // entre réplicas; si el envío fallara, queda en el panel sin haber llegado, que
  // es preferible a mandarlo dos veces.
  const gano = await repo
    .guardarMensaje(tenant.id, conv.id, {
      rol: "assistant",
      contenido: MENSAJE_LIMITE_CLIENTE,
      creadoEn: new Date(ahora).toISOString(),
      waMessageId: `${PREFIJO_AVISO_LIMITE}${conv.id}:${Math.floor(ahora / HORA_MS)}`,
    })
    .catch((e) => {
      console.error("[freno-cliente] no se pudo registrar el aviso de límite:", e);
      return false;
    });
  if (!gano) return true;

  log.warn("limite_cliente_alcanzado", { tenantId: tenant.id, conversacionId: conv.id, turnos: actividad.turnosBotUltimaHora, limite });
  await enviarTexto(tenant, clienteWa, MENSAJE_LIMITE_CLIENTE).catch((e) =>
    console.error("[freno-cliente] no se pudo avisar al cliente:", e),
  );
  await notificarOperador(
    repo,
    tenant,
    conv,
    `⏸️ Este cliente pasó el límite de ${limite} respuestas automáticas por hora: el bot no le contesta hasta que baje el ritmo. Si es un cliente real, atendelo a mano.`,
  ).catch((e) => console.error("[freno-cliente] notificarOperador (límite):", e));
  return true;
}
