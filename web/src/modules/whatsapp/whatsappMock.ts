import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { LocationRef, Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type {
  AgentSettings,
  Channel,
  ChannelTemplates,
  ConversationMode,
  ConversationStatus,
  ConversationSummary,
  Message,
  MessageAuthor,
  Register,
  WhatsappMetrics,
  WhatsappSummary,
} from "./whatsappApi";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp IA en la API simulada (VITE_MOCK_API=1): bandeja, chat, métricas, configuración
// del agente, números conectados y push, con el mismo sobre y los mismos códigos que el
// contrato. Lo llama lib/mockApi.ts con la sesión ya resuelta. El estado vive en
// sessionStorage (cada pestaña o test arranca limpio). Datos ficticios.
//
// Simplificaciones: los cursores son desplazamientos (el real es keyset); la ventana de 24 h
// se calcula con el último mensaje del cliente; "Reabrir con plantilla" simula que el
// cliente contesta a los pocos segundos (así se ve el refresco de la bandeja).
// ─────────────────────────────────────────────────────────────────────────────

export interface MockWhatsappSession {
  businessId: string;
  businessName: string;
  industry: string;
  role: Role;
  modules: string[];
  /** Todas las sucursales del negocio. */
  locations: LocationRef[];
  /** Clientes del negocio (semilla de Clientes): las conversaciones son de ellos. */
  clients: Array<{ id: string; name: string; phone: string | null; anonymized: boolean }>;
}

interface MockConversation {
  id: string;
  clientId: string;
  channelId: string;
  mode: ConversationMode;
  status: ConversationStatus;
  unread: number;
  nextAppointment: { id: string; startsAt: string } | null;
  messages: Message[];
}

interface BusinessState {
  conversations: MockConversation[];
  settings: AgentSettings;
  channels: Channel[];
  /** Respuestas simuladas del cliente que "llegan" cuando pasa su hora. */
  scheduled: { conversationId: string; at: number; text: string }[];
  seq: number;
}

interface WhatsappState {
  businesses: Record<string, BusinessState>;
  pushEndpoints: string[];
}

const STATE_KEY = "selyon.mock.whatsapp";
const LIST_PAGE = 15;
const MESSAGE_PAGE = 20;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW_MS = DAY;
/** Llave VAPID pública de ejemplo (la de la documentación de web-push): solo para el mock. */
const MOCK_VAPID_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const MANAGERS: Role[] = ["owner", "admin"];
const INBOX_ROLES: Role[] = ["owner", "admin", "front_desk"];
const TEMPLATE_NAME = /^[a-z0-9_]*$/;

// ── Respuestas ──────────────────────────────────────────────────────────────

function ok(data: unknown, status = 200): TransportResponse {
  return { status, payload: { ok: true, data } };
}

function noContent(): TransportResponse {
  return { status: 204, payload: undefined };
}

function fail(status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse {
  return { status, payload: { ok: false, error, code, ...(fields ? { fields } : {}) } };
}

const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
const forbiddenRole = () => fail(403, "forbidden_role", "Tu rol no permite hacer este cambio.");

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// ── Medios de ejemplo (se resuelven al responder, para no inflar el sessionStorage) ──

const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d7c7"/><stop offset="1" stop-color="#e8a99a"/></linearGradient></defs>' +
  '<rect width="480" height="360" fill="url(#g)"/><circle cx="240" cy="170" r="92" fill="#fbe9e1"/>' +
  '<path d="M190 200q50 44 100 0" stroke="#b5544a" stroke-width="12" fill="none" stroke-linecap="round"/>' +
  '<circle cx="205" cy="150" r="12" fill="#6b3a35"/><circle cx="275" cy="150" r="12" fill="#6b3a35"/>' +
  '<text x="240" y="330" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#6b3a35">Foto de ejemplo</text></svg>';

let audioUrl: string | null = null;

/** WAV de medio segundo en silencio (8 kHz, 8 bits, mono), armado a mano. */
function silentWav(): string {
  if (audioUrl) return audioUrl;
  const samples = 4000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  audioUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return audioUrl;
}

function resolveMedia(message: Message): Message {
  if (message.mediaUrl === "mock:image") return { ...message, mediaUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(IMAGE_SVG)}` };
  if (message.mediaUrl === "mock:audio") return { ...message, mediaUrl: silentWav() };
  return message;
}

// ── Semilla ─────────────────────────────────────────────────────────────────

type Line = [MessageAuthor, string] | [MessageAuthor, string, "image" | "audio"];

interface Scenario {
  mode: ConversationMode;
  status: ConversationStatus;
  unread: number;
  /** Cita próxima en días desde hoy (null = sin cita). */
  appointmentInDays: number | null;
  lines: Line[];
}

function scenarios(service: string, location: string): Record<string, Scenario> {
  const longLines: Line[] = [["client", "Hola, tengo varias preguntas antes de agendar"]];
  const qa: [string, string][] = [
    ["¿A qué hora abren?", "Abrimos de lunes a viernes de 8:00 a. m. a 6:00 p. m. y los sábados hasta el mediodía."],
    ["¿Tienen parqueo?", "Sí, hay parqueo gratis frente al local."],
    ["¿Aceptan tarjeta?", "Sí: tarjeta, SINPE Móvil y efectivo."],
    ["¿Dónde quedan exactamente?", `Estamos en ${location}, 100 m al este de la iglesia.`],
    [`¿Cuánto dura la ${service}?`, "Unos 45 minutos."],
    ["¿Hay que ir en ayunas?", "No hace falta."],
    ["¿Puedo llevar a mi hija?", "¡Claro! Podemos atenderlas a las dos si agendamos seguido."],
    ["¿Hacen factura electrónica?", "Sí, la pedís al pagar y te llega al correo."],
    ["¿Y si llego tarde?", "Te esperamos hasta 15 minutos; después hay que reagendar."],
    ["¿Puedo cancelar?", "Sí, avisando con 24 horas de anticipación."],
    ["¿Tienen promociones?", "Este mes la valoración es gratis."],
  ];
  for (let round = 0; round < 2; round++) {
    for (const [q, a] of qa) {
      longLines.push(["client", round ? `Otra vez: ${q.charAt(1).toLowerCase()}${q.slice(2)}` : q]);
      longLines.push(["bot", a]);
    }
  }

  return {
    handoff: {
      mode: "human",
      status: "open",
      unread: 2,
      appointmentInDays: null,
      lines: [
        ["client", "Buenas, quería consultar por un tratamiento que me hicieron la semana pasada"],
        ["bot", "¡Hola! Con gusto te ayudo. ¿Me contás un poco más?"],
        ["client", "Me quedó una molestia y prefiero hablar con alguien del equipo"],
        ["bot", "Entiendo. Le paso tu mensaje a una persona del equipo para que te atienda. Te escriben en un momento."],
        ["client", "Ok, quedo atenta"],
        ["client", "¿Me pueden llamar?"],
      ],
    },
    booking: {
      mode: "bot",
      status: "open",
      unread: 1,
      appointmentInDays: 2,
      lines: [
        ["client", `Hola, buenas. ¿Tienen espacio para una ${service} esta semana?`],
        ["bot", "¡Hola! Claro que sí 😊 Tengo el jueves a las 9:00 a. m. o a las 2:30 p. m. ¿Cuál te queda mejor?"],
        ["client", "El jueves a las 2:30 me sirve"],
        ["bot", `¡Listo! Te agendé la ${service} para el jueves a las 2:30 p. m. en ${location}. Te mando un recordatorio un día antes.`],
        ["client", "Gracias!!"],
      ],
    },
    photo: {
      mode: "bot",
      status: "open",
      unread: 0,
      appointmentInDays: null,
      lines: [
        ["client", "Así me quedó, ¿es normal?", "image"],
        ["bot", "Gracias por la foto. Es normal un poco de enrojecimiento las primeras 48 horas. Si sigue después de eso, avisame y te agendo una revisión."],
        ["client", "Perfecto, muchas gracias, cualquier cosa le aviso", "audio"],
        ["bot", "¡Con gusto! Que te mejorés pronto."],
      ],
    },
    long: { mode: "bot", status: "open", unread: 0, appointmentInDays: null, lines: longLines },
    price: {
      mode: "bot",
      status: "attended",
      unread: 0,
      appointmentInDays: null,
      lines: [
        ["client", `¿Cuánto cuesta la ${service}?`],
        ["bot", `La ${service} cuesta ₡25 000 y dura unos 45 minutos. ¿Querés que te agende?`],
        ["client", "Por ahora no, gracias"],
        ["bot", "¡Con gusto! Cuando quieras, escribime y te busco espacio."],
      ],
    },
    reschedule: {
      mode: "bot",
      status: "open",
      unread: 0,
      appointmentInDays: 5,
      lines: [
        ["client", "Necesito mover mi cita del viernes"],
        ["bot", "Claro. ¿Qué día te queda mejor?"],
        ["client", "El lunes en la mañana"],
        ["bot", "Tengo el lunes a las 8:30 a. m. o a las 10:00 a. m."],
        ["client", "8:30"],
        ["bot", "Listo, te pasé la cita al lunes a las 8:30 a. m. ✅"],
      ],
    },
    closed: {
      mode: "human",
      status: "open",
      unread: 0,
      appointmentInDays: null,
      lines: [
        ["client", "Hola, ¿atienden los sábados?"],
        ["bot", "¡Hola! Sí, los sábados atendemos de 8:00 a. m. a 12:00 m. d. ¿Te agendo?"],
        ["client", "Déjeme ver y le aviso"],
        ["human", "¡Hola! Soy del equipo. Cuando sepás qué día te sirve, escribinos y te reservamos."],
      ],
    },
    cancel: {
      mode: "bot",
      status: "attended",
      unread: 0,
      appointmentInDays: null,
      lines: [
        ["client", "Hola, no voy a poder llegar mañana"],
        ["bot", "Gracias por avisar. ¿Querés que cancele la cita o te la paso a otro día?"],
        ["client", "Cancelala por favor, después escribo"],
        ["bot", "Listo, quedó cancelada. ¡Aquí estamos cuando quieras volver!"],
      ],
    },
  };
}

const SERVICE_BY_INDUSTRY: Record<string, string> = { dental: "limpieza", aesthetics: "limpieza facial", nails: "manicura" };
const FILL_ORDER = ["booking", "price", "reschedule", "cancel", "booking", "closed", "price", "reschedule", "cancel"];

function conversationId(businessIndex: number, n: number): string {
  return `da000000-0000-4000-8${businessIndex}00-${String(n).padStart(12, "0")}`;
}

function defaultSettings(session: MockWhatsappSession): AgentSettings {
  const service = SERVICE_BY_INDUSTRY[session.industry] ?? "cita";
  return {
    tone: "Cordial, cercano y breve",
    register: "vos",
    instructions:
      "- Si preguntan por una urgencia, ofrecé el primer espacio del día.\n- No des diagnósticos: invitá a agendar una valoración.",
    knowledge: [
      { id: "precios", title: "Precios", items: [`${service.charAt(0).toUpperCase()}${service.slice(1)}: ₡25 000`, "Valoración: gratis"] },
      { id: "politicas", title: "Políticas", items: ["Cancelaciones con 24 horas de anticipación", "Pagos con SINPE Móvil, tarjeta o efectivo"] },
    ],
    faq: [{ question: "¿Tienen parqueo?", answer: "Sí, frente al local y gratis para clientes." }],
    texts: {
      greeting: `¡Hola! Soy el asistente de ${session.businessName}. ¿En qué te ayudo?`,
      handoff: "Le paso tu mensaje a una persona del equipo. Te escriben en un momento.",
      outOfHours: "Estamos fuera de horario, pero te respondo igual y agendamos lo que necesités.",
      fallback: "No tengo ese dato a mano. ¿Querés que le pregunte a alguien del equipo?",
    },
  };
}

function defaultChannels(session: MockWhatsappSession, businessIndex: number): Channel[] {
  const templates = (reopen: string): ChannelTemplates => ({ reminder: "recordatorio_cita", reopen, marketing: "" });
  if (session.locations.length > 1) {
    return session.locations.slice(0, 2).map((location, i) => ({
      id: `ch00000${businessIndex}-0000-4000-8000-00000000000${i + 1}`,
      phoneNumber: i === 0 ? "+50640001234" : "+50640005678",
      displayName: i === 0 ? session.businessName : `${session.businessName} · ${location.name}`,
      locationId: location.id,
      status: i === 0 ? "connected" : "token_expired",
      templates: templates(i === 0 ? "reapertura_conversacion" : ""),
    }));
  }
  return [
    {
      id: `ch00000${businessIndex}-0000-4000-8000-000000000001`,
      phoneNumber: "+50640009999",
      displayName: session.businessName,
      locationId: null,
      status: "connected",
      templates: templates(""),
    },
  ];
}

function seedBusiness(session: MockWhatsappSession): BusinessState {
  const businessIndex = Number(session.businessId.slice(-1)) || 0;
  const now = Date.now();
  const channels = defaultChannels(session, businessIndex);
  const location = session.locations[0]?.name ?? "el local";
  const library = scenarios(SERVICE_BY_INDUSTRY[session.industry] ?? "cita", location);
  const clients = session.clients.filter((c) => c.phone && !c.anonymized).slice(0, 30);
  const head = ["handoff", "booking", "photo", "long", "price", "reschedule", "closed"];

  const conversations = clients.map((client, k): MockConversation => {
    const key = k < head.length ? head[k] : FILL_ORDER[(k - head.length) % FILL_ORDER.length];
    const scenario = library[key];
    // Las primeras, de hoy; las demás, de días anteriores (con la ventana de 24 h cerrada).
    const anchor = key === "closed" ? now - 2 * DAY - 3 * HOUR : k < head.length ? now - (6 + k * 38) * MIN : now - (k - 5) * 0.8 * DAY;
    const lines = scenario.lines;
    const id = conversationId(businessIndex, k + 1);
    // Mensajes cada 1-3 minutos hasta llegar al último en `anchor` (en "closed", el del
    // equipo dos horas después de lo del cliente).
    const offsets = lines.map(() => 0);
    for (let i = lines.length - 2; i >= 0; i--) offsets[i] = offsets[i + 1] + (1 + (i % 3)) * MIN;
    if (key === "closed") for (let i = 0; i < lines.length - 1; i++) offsets[i] += 2 * HOUR;
    const messages = lines.map(([by, text, media], i): Message => ({
      id: `${id}-m${String(i + 1).padStart(3, "0")}`,
      direction: by === "client" ? "in" : "out",
      by,
      text,
      ...(media ? { mediaType: media, mediaUrl: `mock:${media}` } : {}),
      at: new Date(anchor - offsets[i]).toISOString(),
    }));
    const appointmentDay = scenario.appointmentInDays;
    return {
      id,
      clientId: client.id,
      channelId: channels[k % 4 === 3 && channels.length > 1 ? 1 : 0].id,
      mode: scenario.mode,
      status: k >= head.length && k % 3 === 0 ? "attended" : scenario.status,
      unread: scenario.unread,
      nextAppointment:
        appointmentDay === null
          ? null
          : { id: `ap000000-0000-4000-8000-${String(k + 1).padStart(12, "0")}`, startsAt: new Date(Math.ceil((now + appointmentDay * DAY) / HOUR) * HOUR).toISOString() },
      messages,
    };
  });

  return { conversations, settings: defaultSettings(session), channels, scheduled: [], seq: 0 };
}

// ── Estado ──────────────────────────────────────────────────────────────────

function loadState(): WhatsappState {
  const raw = readStorage(STATE_KEY, "session");
  if (!raw) return { businesses: {}, pushEndpoints: [] };
  try {
    return { businesses: {}, pushEndpoints: [], ...(JSON.parse(raw) as Partial<WhatsappState>) };
  } catch {
    return { businesses: {}, pushEndpoints: [] };
  }
}

function saveState(state: WhatsappState): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

// ── Lógica ──────────────────────────────────────────────────────────────────

function lastClientAt(c: MockConversation): number {
  for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].direction === "in") return Date.parse(c.messages[i].at);
  return 0;
}

const isWindowOpen = (c: MockConversation, now = Date.now()) => now - lastClientAt(c) < WINDOW_MS;

function summaryOf(c: MockConversation, session: MockWhatsappSession): ConversationSummary {
  const client = session.clients.find((x) => x.id === c.clientId);
  const last = c.messages[c.messages.length - 1];
  return {
    id: c.id,
    client: { id: c.clientId, name: client?.anonymized ? null : (client?.name ?? null), phone: client?.phone ?? null },
    lastMessage: last
      ? { text: last.text || (last.mediaType === "image" ? "📷 Foto" : last.mediaType === "audio" ? "🎤 Audio" : ""), at: last.at, direction: last.direction }
      : null,
    unread: c.unread,
    mode: c.mode,
    status: c.status,
    windowOpen: isWindowOpen(c),
    nextAppointment: c.nextAppointment && Date.parse(c.nextAppointment.startsAt) > Date.now() ? c.nextAppointment : null,
  };
}

/** Aplica las respuestas simuladas del cliente cuya hora ya pasó. */
function deliverScheduled(b: BusinessState): void {
  const now = Date.now();
  const due = b.scheduled.filter((s) => s.at <= now);
  if (due.length === 0) return;
  b.scheduled = b.scheduled.filter((s) => s.at > now);
  for (const s of due) {
    const c = b.conversations.find((x) => x.id === s.conversationId);
    if (!c) continue;
    b.seq += 1;
    c.messages.push({ id: `${c.id}-r${b.seq}`, direction: "in", by: "client", text: s.text, at: new Date(s.at).toISOString() });
    c.unread += 1;
    c.status = "open";
  }
}

function visibleTo(b: BusinessState, locationId: string | undefined): MockConversation[] {
  if (!locationId) return b.conversations;
  const channelIds = new Set(b.channels.filter((ch) => ch.locationId === null || ch.locationId === locationId).map((ch) => ch.id));
  return b.conversations.filter((c) => channelIds.has(c.channelId));
}

function isDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function metricsFor(businessId: string, from: string, to: string): WhatsappMetrics {
  const byDay: WhatsappMetrics["byDay"] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = start; t <= end && byDay.length < 366; t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    const h = hash(businessId + date);
    const weekday = new Date(t).getUTCDay();
    const conversations = weekday === 0 ? h % 3 : 4 + (h % 11);
    const bookings = Math.round(conversations * (0.25 + ((h >> 8) % 30) / 100));
    byDay.push({ date, conversations, bookings });
  }
  const conversations = byDay.reduce((s, d) => s + d.conversations, 0);
  const bookingsByAgent = byDay.reduce((s, d) => s + d.bookings, 0);
  const handoffs = Math.round(conversations * 0.12);
  return {
    conversations,
    resolvedWithoutHuman: conversations - handoffs,
    bookingsByAgent,
    handoffs,
    aiCostMicros: conversations * 18_400 + bookingsByAgent * 6_100,
    byDay,
  };
}

function validateSettings(body: unknown): { settings: AgentSettings } | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const tone = field(body, "tone");
  const register = field(body, "register");
  const instructions = field(body, "instructions");
  const knowledge = field(body, "knowledge");
  const faq = field(body, "faq");
  const texts = field(body, "texts");
  if (typeof tone !== "string" || tone.length > 200) fields["body.tone"] = "Máximo 200 caracteres.";
  if (register !== "vos" && register !== "tu" && register !== "usted") fields["body.register"] = "Elegí cómo trata el agente al cliente.";
  if (typeof instructions !== "string" || instructions.length > 4000) fields["body.instructions"] = "Máximo 4000 caracteres.";
  const sections = Array.isArray(knowledge) ? knowledge : [];
  if (!Array.isArray(knowledge)) fields["body.knowledge"] = "Formato inválido.";
  sections.forEach((s, i) => {
    if (typeof field(s, "title") !== "string" || !(field(s, "title") as string).trim()) fields[`body.knowledge.${i}.title`] = "Poné un título a la sección.";
  });
  const entries = Array.isArray(faq) ? faq : [];
  if (!Array.isArray(faq)) fields["body.faq"] = "Formato inválido.";
  entries.forEach((f, i) => {
    if (typeof field(f, "question") !== "string" || !(field(f, "question") as string).trim()) fields[`body.faq.${i}.question`] = "Escribí la pregunta.";
    if (typeof field(f, "answer") !== "string" || !(field(f, "answer") as string).trim()) fields[`body.faq.${i}.answer`] = "Escribí la respuesta.";
  });
  if (typeof texts !== "object" || texts === null || Object.values(texts).some((v) => typeof v !== "string")) fields["body.texts"] = "Formato inválido.";
  if (Object.keys(fields).length > 0) return { fields };
  return {
    settings: {
      tone: (tone as string).trim(),
      register: register as Register,
      instructions: (instructions as string).trim(),
      knowledge: sections.map((s) => ({
        id: String(field(s, "id") ?? "") || fold(String(field(s, "title"))).replace(/[^a-z0-9]+/g, "-"),
        title: String(field(s, "title")).trim(),
        items: (Array.isArray(field(s, "items")) ? (field(s, "items") as unknown[]) : []).map(String).map((x) => x.trim()).filter(Boolean),
      })),
      faq: entries.map((f) => ({ question: String(field(f, "question")).trim(), answer: String(field(f, "answer")).trim() })),
      texts: Object.fromEntries(Object.entries(texts as Record<string, string>).map(([k, v]) => [k, v.trim()])),
    },
  };
}

// ── Rutas ───────────────────────────────────────────────────────────────────

/** Rutas /whatsapp/* y /push/* del mock. null si la ruta no es de este módulo. */
export function routeWhatsappMock(req: TransportRequest, session: MockWhatsappSession, locationId?: string): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (!path.startsWith("/whatsapp/") && !path.startsWith("/push/")) return null;

  const state = loadState();
  const result = handle(req, url, path, session, state, locationId);
  saveState(state);
  return result;
}

function handle(req: TransportRequest, url: URL, path: string, session: MockWhatsappSession, state: WhatsappState, locationId?: string): TransportResponse {
  const { method, body } = req;

  // ── Push (de la cuenta, no del módulo) ──
  if (path.startsWith("/push/")) {
    switch (`${method} ${path}`) {
      case "GET /push/public-key":
        return ok({ key: MOCK_VAPID_KEY });
      case "POST /push/subscribe": {
        const endpoint = field(body, "endpoint");
        const keys = field(body, "keys");
        if (typeof endpoint !== "string" || !endpoint || typeof keys !== "object" || keys === null) return invalid({ "body.endpoint": "Suscripción inválida." });
        if (!state.pushEndpoints.includes(endpoint)) state.pushEndpoints.push(endpoint);
        return noContent();
      }
      case "POST /push/unsubscribe": {
        const endpoint = field(body, "endpoint");
        state.pushEndpoints = state.pushEndpoints.filter((e) => e !== endpoint);
        return noContent();
      }
      case "POST /push/test":
        return ok({ sent: state.pushEndpoints.length });
    }
    return fail(404, "not_found", "Ruta inexistente en el mock.");
  }

  if (!session.modules.includes("whatsapp")) return fail(403, "module_not_in_plan", "Esta función no está incluida en tu plan.");
  if (!INBOX_ROLES.includes(session.role)) return fail(403, "forbidden", "No tenés permiso para hacer esto.");

  const b = (state.businesses[session.businessId] ??= seedBusiness(session));
  deliverScheduled(b);
  const conversations = visibleTo(b, locationId);
  const now = Date.now();

  // ── Bandeja ──
  if (method === "GET" && path === "/whatsapp/conversations") {
    const status = url.searchParams.get("status") ?? "open";
    if (!["open", "attended", "all"].includes(status)) return invalid({ "query.status": "Filtro inválido." });
    const terms = fold(url.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
    const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
    const rows = conversations
      .map((c) => summaryOf(c, session))
      .filter((c) => status === "all" || c.status === status)
      .filter((c) =>
        terms.every((term) => {
          const digits = term.replace(/\D/g, "");
          return (
            fold(c.client.name ?? "").includes(term) ||
            fold(c.lastMessage?.text ?? "").includes(term) ||
            (digits.length >= 3 && (c.client.phone ?? "").includes(digits))
          );
        }),
      )
      .sort((x, y) => (y.lastMessage?.at ?? "").localeCompare(x.lastMessage?.at ?? "") || x.id.localeCompare(y.id));
    const page = rows.slice(offset, offset + LIST_PAGE);
    return ok({ items: page, nextCursor: offset + LIST_PAGE < rows.length ? String(offset + LIST_PAGE) : null });
  }

  if (method === "GET" && path === "/whatsapp/summary") {
    const weekAgo = now - 7 * DAY;
    const summary: WhatsappSummary = {
      conversationsWaiting: conversations.filter((c) => c.status === "open" && c.mode === "human" && c.messages[c.messages.length - 1]?.direction === "in").length,
      openConversations: conversations.filter((c) => c.status === "open").length,
      conversationsThisWeek: conversations.filter((c) => Date.parse(c.messages[c.messages.length - 1]?.at ?? "") > weekAgo).length,
      bookingsByAgentThisWeek: conversations.filter((c) => c.nextAppointment).length + 4,
      handoffsThisWeek: conversations.filter((c) => c.mode === "human").length,
    };
    return ok(summary);
  }

  if (method === "GET" && path === "/whatsapp/metrics") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!isDate(from) || !isDate(to) || from > to) return invalid({ "query.from": "Rango de fechas inválido." });
    return ok(metricsFor(session.businessId, from, to));
  }

  const convMatch = /^\/whatsapp\/conversations\/([^/]+)(?:\/(messages|mode|status|read|reopen))?$/.exec(path);
  if (convMatch) {
    const c = conversations.find((x) => x.id === decodeURIComponent(convMatch[1]));
    if (!c) return fail(404, "not_found", "No encontramos esa conversación.");
    const action = convMatch[2];

    if (method === "GET" && !action) {
      const before = url.searchParams.get("before");
      const end = before === null ? c.messages.length : Math.max(0, Math.min(Number(before) || 0, c.messages.length));
      const start = Math.max(0, end - MESSAGE_PAGE);
      return ok({
        conversation: summaryOf(c, session),
        messages: c.messages.slice(start, end).map(resolveMedia),
        nextBefore: start > 0 ? String(start) : null,
      });
    }
    if (method !== "POST") return fail(404, "not_found", "Ruta inexistente en el mock.");

    switch (action) {
      case "messages": {
        const text = field(body, "text");
        if (typeof text !== "string" || !text.trim()) return invalid({ "body.text": "Escribí un mensaje." });
        if (text.length > 4096) return invalid({ "body.text": "Máximo 4096 caracteres." });
        if (!isWindowOpen(c, now)) return fail(409, "window_closed", "Pasaron más de 24 horas desde el último mensaje del cliente: reabrí la conversación con una plantilla.");
        // Como el backend: si alguien del equipo responde, la conversación pasa a una persona.
        c.mode = "human";
        b.seq += 1;
        const message: Message = { id: `${c.id}-h${b.seq}`, direction: "out", by: "human", text: text.trim(), at: new Date(now).toISOString() };
        c.messages.push(message);
        return ok(message, 201);
      }
      case "mode": {
        const mode = field(body, "mode");
        if (mode !== "bot" && mode !== "human") return invalid({ "body.mode": "Modo inválido." });
        c.mode = mode;
        return ok(summaryOf(c, session));
      }
      case "status": {
        const status = field(body, "status");
        if (status !== "open" && status !== "attended") return invalid({ "body.status": "Estado inválido." });
        c.status = status;
        return ok(summaryOf(c, session));
      }
      case "read":
        c.unread = 0;
        return noContent();
      case "reopen": {
        if (isWindowOpen(c, now)) return fail(409, "window_open", "La ventana de 24 horas está abierta: podés escribirle directamente.");
        const channel = b.channels.find((ch) => ch.id === c.channelId);
        const template = channel?.templates.reopen;
        if (!template) {
          return fail(409, "reopen_template_missing", "Este número no tiene plantilla de reapertura: configurala en WhatsApp IA › Configuración.");
        }
        b.seq += 1;
        c.messages.push({
          id: `${c.id}-t${b.seq}`,
          direction: "out",
          by: "human",
          text: `Plantilla «${template}»: ¡Hola! Te escribimos de ${session.businessName} para retomar tu consulta. ¿Te podemos ayudar?`,
          at: new Date(now).toISOString(),
        });
        c.status = "open";
        b.scheduled.push({ conversationId: c.id, at: now + 6_000, text: "¡Hola! Sí, todavía me interesa." });
        return ok({ sent: true });
      }
    }
  }

  // ── Configuración del agente ──
  if (path === "/whatsapp/settings") {
    if (method === "GET") return ok(b.settings);
    if (method === "PATCH") {
      if (!MANAGERS.includes(session.role)) return forbiddenRole();
      const result = validateSettings(body);
      if ("fields" in result) return invalid(result.fields);
      b.settings = result.settings;
      return ok(b.settings);
    }
  }

  // ── Números conectados ──
  if (method === "GET" && path === "/whatsapp/channels") return ok(b.channels);
  if (method === "GET" && path === "/whatsapp/channels/signup-config") {
    if (!MANAGERS.includes(session.role)) return forbiddenRole();
    return ok({ appId: "100000000000001", configId: "200000000000002", graphVersion: "v21.0" });
  }
  if (method === "POST" && path === "/whatsapp/channels/connect") {
    if (!MANAGERS.includes(session.role)) return forbiddenRole();
    const code = field(body, "code");
    if (typeof code !== "string" || !code) return invalid({ "body.code": "Falta el código de Meta." });
    b.seq += 1;
    const channel: Channel = {
      id: `ch0000ff-0000-4000-8000-${String(b.seq).padStart(12, "0")}`,
      phoneNumber: `+5064000${String(7000 + b.seq).padStart(4, "0")}`,
      displayName: session.businessName,
      locationId: null,
      status: "connected",
      templates: { reminder: "", reopen: "", marketing: "" },
    };
    b.channels.push(channel);
    return ok(channel, 201);
  }
  const channelMatch = /^\/whatsapp\/channels\/([^/]+)(\/test)?$/.exec(path);
  if (channelMatch) {
    const channel = b.channels.find((ch) => ch.id === decodeURIComponent(channelMatch[1]));
    if (!channel) return fail(404, "not_found", "No encontramos ese número.");
    if (!MANAGERS.includes(session.role)) return forbiddenRole();
    if (method === "POST" && channelMatch[2]) {
      if (channel.status === "token_expired") return fail(409, "token_expired", "El acceso de Meta a este número venció: volvé a conectarlo.");
      if (channel.status === "disconnected") return fail(409, "channel_disconnected", "Este número está desconectado.");
      return ok({ sent: true });
    }
    if (method === "PATCH" && !channelMatch[2]) {
      const location = field(body, "locationId");
      const templates = field(body, "templates");
      const fields: Record<string, string> = {};
      if (location !== null && !session.locations.some((l) => l.id === location)) fields["body.locationId"] = "Sucursal inválida.";
      const next = { ...channel.templates };
      for (const key of ["reminder", "reopen", "marketing"] as const) {
        const value = field(templates, key);
        if (typeof value !== "string" || !TEMPLATE_NAME.test(value.trim())) {
          fields[`body.templates.${key}`] = "Usá el nombre exacto de la plantilla en Meta (minúsculas, números y guion bajo).";
        } else next[key] = value.trim();
      }
      if (Object.keys(fields).length > 0) return invalid(fields);
      channel.locationId = location as string | null;
      channel.templates = next;
      return ok(channel);
    }
  }

  return fail(404, "not_found", "Ruta inexistente en el mock.");
}
