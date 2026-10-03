import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { waConversaciones, type schema } from "../db/schema";
import { obtenerDb } from "../db/client";
import { tenantPuede } from "../billing/planes";
import { enviarBotones, enviarTexto } from "../whatsapp/client";
import type { Conversacion, OpcionInteractiva, Repositorio, Tenant } from "../types";
import { enmascararTelefono } from "../observabilidad/privacidad";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Consentimiento de marketing + baja (revisión pre-venta 2026-10, cumplimiento).
//
// ANTES: el segmento "todos" de las campañas incluía a cualquiera que alguna vez
// escribió (salvo los dados de baja), `opt_in_en` se marcaba solo por recibir el
// aviso de "soy un bot", y la baja solo funcionaba con el texto EXACTO "baja".
// Eso no es consentimiento (Ley 8968 de Costa Rica ni la política de mensajes de
// marketing de WhatsApp Business).
//
// AHORA:
//   • Consentimiento EXPLÍCITO: un mensaje con botones "Sí / No" que el cliente
//     tiene que tocar. Se guarda en `wa_conversaciones.marketing_consentimiento_en`
//     y las campañas SOLO van a quien lo tiene (segmentos.ts + worker.ts).
//   • Cuándo se pregunta (el punto MENOS invasivo): el bot lo ofrece UNA sola vez,
//     justo después de que el cliente responde bien ("Todo bien"/"Excelente"/"Bien")
//     al seguimiento post-servicio de una cita ya hecha. Ahí el cliente ya es
//     cliente real, acaba de tener una buena experiencia, la ventana de 24 h está
//     abierta (no cuesta plantilla) y no interrumpe ninguna consulta en curso. NO
//     se pregunta en el primer contacto: quien escribe para preguntar un precio
//     todavía no tiene relación con el negocio y la pregunta estorba. Además, el
//     negocio puede pedirlo a mano desde el chat del panel (con ventana abierta y
//     sin re-preguntar antes de 30 días).
//   • Baja normalizada: "baja", "BAJA.", "stop", "cancelar suscripción", "no
//     quiero más promociones", "no me manden más"… (sin tildes ni puntuación,
//     mensaje CORTO y completo — "quiero cancelar mi cita" no es baja).
//
// Vive acá, DB-directo (mismo precedente que campanias.ts), y no en la interfaz
// Repositorio: es dato de marketing que solo tiene sentido con Postgres real. Sin
// DATABASE_URL (dev/tests/SEED_DEMO) cae a un almacén en memoria del proceso para
// que el flujo de botones funcione igual.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1) Baja ("opt-out") normalizada ──────────────────────────────────────────

/** minúsculas, sin tildes, solo letras/dígitos separados por un espacio (mismo criterio que traspasoHumano.ts). */
export function normalizarComando(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Saludo/cortesía opcional antes y después del pedido: "hola, baja por favor", "stop gracias".
const PREFIJO = "(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|ok|okay|ya)\\s+)*";
const SUFIJO = "(?:\\s+(?:por favor|porfa|porfis|please|pls|gracias|ya))*";

// Qué se deja de recibir. Sin "fotos", "citas", "recordatorios", etc.: no son marketing.
const QUE = "(?:promociones|promocion|promos|promo|publicidad|ofertas|anuncios|campanas|mensajes|novedades)";

const PEDIDOS_BAJA: RegExp[] = [
  // Comandos de una palabra o frase fija.
  /^(?:baja|stop|unsubscribe|desuscribir|desuscribirme|desuscribanme|desinscribirme)$/,
  /^(?:quiero\s+)?(?:darme|dar|dame|denme|me\s+doy)\s+de\s+baja$/,
  /^(?:quiero\s+)?(?:cancelar|anular)\s+(?:mi\s+|la\s+)?suscripcion$/,
  // "no quiero (recibir) más promociones/mensajes", "ya no deseo recibir publicidad".
  new RegExp(`^(?:ya\\s+)?no\\s+(?:quiero|deseo|necesito)\\s+(?:recibir\\s+)?(?:mas\\s+)?${QUE}(?:\\s+de\\s+ustedes)?$`),
  // "no me manden más", "no me envíen más mensajes", "ya no me escriban más".
  new RegExp(
    `^(?:ya\\s+)?no\\s+(?:me\\s+)?(?:manden|mande|envien|envie|escriban|sigan\\s+mandando|sigan\\s+enviando)\\s+mas(?:\\s+${QUE})?$`,
  ),
  // "dejar de recibir promociones", "quiero dejar de recibir mensajes".
  new RegExp(`^(?:quiero\\s+)?dejar\\s+de\\s+recibir\\s+${QUE}$`),
];

/** Largo máximo (normalizado) de un pedido de baja: es un mensaje corto, no una frase dentro de una conversación. */
const MAX_LARGO_BAJA = 60;

/**
 * true si el mensaje COMPLETO es un pedido de baja de promociones. Tolera tildes,
 * mayúsculas, puntuación, emojis y un saludo/cortesía alrededor; NO dispara con
 * frases que solo contienen la palabra ("quiero cancelar mi cita", "baja el precio?").
 */
export function esPedidoDeBaja(texto: string): boolean {
  const t = normalizarComando(texto);
  if (!t || t.length > MAX_LARGO_BAJA) return false;
  const nucleo = t.replace(new RegExp(`^${PREFIJO}`), "").replace(new RegExp(`${SUFIJO}$`), "").trim();
  if (!nucleo) return false;
  return PEDIDOS_BAJA.some((re) => re.test(nucleo));
}

export const ACK_BAJA =
  "Listo, no vas a recibir más promociones de nuestra parte. Si tenés una cita agendada, igual te van a llegar sus recordatorios. Si necesitás algo más, escribinos por acá 🙂";

// ── 2) Protocolo de los botones Sí/No ────────────────────────────────────────

const ID_SI = "mktsi";
const ID_NO = "mktno";

/** Botones del pedido de consentimiento (≤20 chars por título, límite de Meta). */
export function botonesConsentimiento(): OpcionInteractiva[] {
  return [
    { id: ID_SI, titulo: "Sí, avísenme" },
    { id: ID_NO, titulo: "No, gracias" },
  ];
}

/** "si" | "no" si la respuesta interactiva es del pedido de consentimiento; null si no. */
export function respuestaConsentimiento(interactiveId: string | undefined): "si" | "no" | null {
  if (!interactiveId) return null;
  const tipo = interactiveId.split("|")[0];
  if (tipo === ID_SI) return "si";
  if (tipo === ID_NO) return "no";
  return null;
}

/** Texto del pedido: dice QUIÉN escribe, QUÉ se va a mandar y CÓMO darse de baja. */
export function textoPedidoConsentimiento(nombreNegocio: string): string {
  return (
    `¿Te gustaría que ${nombreNegocio} te avise por WhatsApp de promociones y novedades de vez en cuando? ` +
    "Es opcional y podés darte de baja cuando quieras escribiendo BAJA."
  );
}

export const ACK_SI =
  "¡Listo! 🙌 Te vamos a avisar de promociones de vez en cuando. Si en algún momento no querés recibir más, escribí BAJA.";
export const ACK_NO = "Entendido, no te vamos a enviar promociones. ¡Gracias! 🙂";

// ── 3) Almacén del consentimiento ─────────────────────────────────────────────

export interface EstadoConsentimiento {
  consentimientoEn: Date | null;
  pedidoEn: Date | null;
}

export interface AlmacenConsentimiento {
  leer(tenantId: string, clienteWa: string): Promise<EstadoConsentimiento>;
  /** Registra que se le preguntó (para no insistir). */
  marcarPedido(tenantId: string, clienteWa: string): Promise<void>;
  /** El cliente tocó "Sí": consentimiento con fecha. Un "Sí" posterior a una baja la deja sin efecto (vale lo último que dijo). */
  otorgar(tenantId: string, clienteWa: string): Promise<void>;
  /** El cliente tocó "No" o pidió la baja: se borra el consentimiento. */
  revocar(tenantId: string, clienteWa: string): Promise<void>;
}

function almacenDb(db: DB): AlmacenConsentimiento {
  const donde = (tenantId: string, clienteWa: string) =>
    and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa));
  return {
    async leer(tenantId, clienteWa) {
      const [fila] = await db
        .select({
          consentimientoEn: waConversaciones.marketingConsentimientoEn,
          pedidoEn: waConversaciones.marketingConsentimientoPedidoEn,
        })
        .from(waConversaciones)
        .where(donde(tenantId, clienteWa))
        .limit(1);
      return { consentimientoEn: fila?.consentimientoEn ?? null, pedidoEn: fila?.pedidoEn ?? null };
    },
    async marcarPedido(tenantId, clienteWa) {
      await db
        .update(waConversaciones)
        .set({ marketingConsentimientoPedidoEn: new Date() })
        .where(donde(tenantId, clienteWa));
    },
    async otorgar(tenantId, clienteWa) {
      await db
        .update(waConversaciones)
        .set({ marketingConsentimientoEn: new Date(), optOutEn: null })
        .where(donde(tenantId, clienteWa));
    },
    async revocar(tenantId, clienteWa) {
      await db
        .update(waConversaciones)
        .set({ marketingConsentimientoEn: null })
        .where(donde(tenantId, clienteWa));
    },
  };
}

// Fallback sin base (dev/tests/SEED_DEMO): vive en el proceso, se pierde al reiniciar.
const memoria = new Map<string, EstadoConsentimiento>();
const clave = (tenantId: string, clienteWa: string) => `${tenantId}|${clienteWa}`;

const almacenMemoria: AlmacenConsentimiento = {
  async leer(tenantId, clienteWa) {
    return { ...(memoria.get(clave(tenantId, clienteWa)) ?? { consentimientoEn: null, pedidoEn: null }) };
  },
  async marcarPedido(tenantId, clienteWa) {
    const e = memoria.get(clave(tenantId, clienteWa)) ?? { consentimientoEn: null, pedidoEn: null };
    memoria.set(clave(tenantId, clienteWa), { ...e, pedidoEn: new Date() });
  },
  async otorgar(tenantId, clienteWa) {
    const e = memoria.get(clave(tenantId, clienteWa)) ?? { consentimientoEn: null, pedidoEn: null };
    memoria.set(clave(tenantId, clienteWa), { ...e, consentimientoEn: new Date() });
  },
  async revocar(tenantId, clienteWa) {
    const e = memoria.get(clave(tenantId, clienteWa)) ?? { consentimientoEn: null, pedidoEn: null };
    memoria.set(clave(tenantId, clienteWa), { ...e, consentimientoEn: null });
  },
};

/** Solo para tests: vacía el almacén en memoria. */
export function _resetConsentimientoMemoriaParaTests(): void {
  memoria.clear();
}

/**
 * Almacén a usar: el `db` explícito (tests de fiabilidad con PGlite), el pool
 * singleton si hay DATABASE_URL, o el de memoria si no hay base.
 */
export function almacenConsentimiento(db?: DB): AlmacenConsentimiento {
  if (db) return almacenDb(db);
  if (process.env.DATABASE_URL) return almacenDb(obtenerDb());
  return almacenMemoria;
}

// ── 4) Flujos ────────────────────────────────────────────────────────────────

/** No re-preguntar a mano antes de esto (anti-insistencia). */
export const DIAS_ENTRE_PEDIDOS = 30;

export type ResultadoPedido =
  | "enviado"
  | "sin_plan" // el plan del negocio no tiene campañas: no tiene sentido pedirlo
  | "baja" // el cliente pidió la baja: se respeta, no se le vuelve a preguntar
  | "ya_consiente"
  | "ya_preguntado";

/**
 * Decide si corresponde pedir el consentimiento. Pura (sin I/O) para poder
 * probar la política. `manual` = lo pidió el negocio desde el panel (permite
 * re-preguntar pasado DIAS_ENTRE_PEDIDOS); el ofrecimiento automático del bot
 * pregunta UNA sola vez en la vida del cliente.
 */
export function decidirPedido(
  tenant: Tenant,
  conv: Pick<Conversacion, "optOutEn">,
  estado: EstadoConsentimiento,
  manual: boolean,
  ahora: Date = new Date(),
): Exclude<ResultadoPedido, "enviado"> | null {
  if (!tenantPuede(tenant, "campanias")) return "sin_plan";
  if (conv.optOutEn) return "baja";
  if (estado.consentimientoEn) return "ya_consiente";
  if (estado.pedidoEn) {
    if (!manual) return "ya_preguntado";
    const dias = (ahora.getTime() - estado.pedidoEn.getTime()) / 86_400_000;
    if (dias < DIAS_ENTRE_PEDIDOS) return "ya_preguntado";
  }
  return null;
}

/**
 * Manda el mensaje con botones Sí/No si corresponde (ver decidirPedido) y lo deja
 * en el historial. Requiere ventana de 24 h abierta: el caller lo garantiza (el
 * bot lo llama justo después de que el cliente tocó un botón; el panel lo valida).
 */
export async function pedirConsentimientoMarketing(
  tenant: Tenant,
  repo: Repositorio,
  conv: Conversacion,
  opciones: { manual: boolean; almacen?: AlmacenConsentimiento },
): Promise<ResultadoPedido> {
  const almacen = opciones.almacen ?? almacenConsentimiento();
  const estado = await almacen.leer(tenant.id, conv.clienteWa);
  const motivo = decidirPedido(tenant, conv, estado, opciones.manual);
  if (motivo) return motivo;

  const cuerpo = textoPedidoConsentimiento(tenant.nombre);
  await enviarBotones(tenant, conv.clienteWa, cuerpo, botonesConsentimiento());
  await almacen.marcarPedido(tenant.id, conv.clienteWa);
  await repo.guardarMensaje(tenant.id, conv.id, {
    rol: "assistant",
    contenido: `${cuerpo} [Sí, avísenme / No, gracias]`,
    creadoEn: new Date().toISOString(),
    ...(opciones.manual ? { porHumano: true } : {}),
  });
  console.log(`[consentimiento] pedido enviado a ${enmascararTelefono(conv.clienteWa)} (tenant ${tenant.id}, ${opciones.manual ? "panel" : "bot"})`);
  return "enviado";
}

/**
 * El cliente tocó "Sí" o "No". Acción directa (no pasa por el agente ni depende
 * del modo humano/bot, igual que la baja). El propio mensaje entrante con el botón
 * queda guardado en wa_mensajes como evidencia de qué respondió y cuándo.
 */
export async function procesarRespuestaConsentimiento(
  tenant: Tenant,
  repo: Repositorio,
  conv: Conversacion,
  respuesta: "si" | "no",
  almacen: AlmacenConsentimiento = almacenConsentimiento(),
): Promise<void> {
  if (respuesta === "si") await almacen.otorgar(tenant.id, conv.clienteWa);
  else await almacen.revocar(tenant.id, conv.clienteWa);
  const ack = respuesta === "si" ? ACK_SI : ACK_NO;
  await enviarTexto(tenant, conv.clienteWa, ack);
  await repo.guardarMensaje(tenant.id, conv.id, { rol: "assistant", contenido: ack, creadoEn: new Date().toISOString() });
  console.log(`[consentimiento] ${enmascararTelefono(conv.clienteWa)} (tenant ${tenant.id}) respondió "${respuesta}"`); // log-pii-ok: respuesta es el enum "si" | "no"
}
