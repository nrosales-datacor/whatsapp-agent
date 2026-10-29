import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { LocationRef, Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import { fail, forbiddenRole, invalid, ok } from "../clients/crmMock";
import { mockMarketingAudience, mockMarketingReachable, mockClientsOf, type MockSegment } from "../clients/clientsMock";
import type { CampaignDetail, CampaignSegment, CampaignSendStatus, CampaignStatus, CampaignSummary, SendCounts } from "./campaignsApi";
import { MAX_MESSAGE } from "./campaignsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre y códigos que
// src/modules/campaigns. La audiencia sale de los clientes simulados (consentimiento, baja,
// teléfono y filtros del CRM); el estado de los números, de WhatsApp IA simulado.
//
// Ciclo de vida: al lanzar, la campaña pasa a "Enviando" y cada vez que se la consulta
// avanza un envío cada ENVIO_MS (re-chequeando el consentimiento, como el despacho real)
// hasta quedar "Enviada". Una programada pasa a "Enviando" cuando llega su hora. Los
// resultados (respondieron, citas) son una fracción fija de lo enviado.
// Simplificaciones: "Te toca de nuevo" y "sin cita próxima" no filtran.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockCampaignsSession {
  businessId: string;
  role: Role;
  modules: string[];
  industry: string;
  timezone: string;
  locations: LocationRef[];
  /** Números activos y con plantilla de marketing (de WhatsApp IA simulado). */
  channels: () => { connected: number; withTemplate: number };
}

interface MockSend {
  clientId: string;
  name: string;
  status: CampaignSendStatus;
  error: string | null;
  sentAt: string | null;
}

interface MockCampaign {
  id: string;
  name: string;
  message: string;
  segment: CampaignSegment;
  status: CampaignStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  sends: MockSend[];
}

type State = Record<string, MockCampaign[]>;

const STATE_KEY = "selyon.mock.campaigns";
const ENVIO_MS = 150;
const MANAGERS: Role[] = ["owner", "admin"];

function loadState(): State {
  const raw = readStorage(STATE_KEY, "session");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

function countsOf(c: MockCampaign): SendCounts {
  const counts: SendCounts = { total: c.sends.length, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const s of c.sends) {
    if (s.status === "sent") counts.sent++;
    else if (s.status === "failed") counts.failed++;
    else if (s.status === "skipped") counts.skipped++;
    else counts.pending++;
  }
  return counts;
}

function summaryOf(c: MockCampaign): CampaignSummary {
  return {
    id: c.id,
    name: c.name,
    message: c.message,
    segment: c.segment,
    status: c.status,
    scheduledFor: c.scheduledFor,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    createdAt: c.createdAt,
    totalRecipients: c.status === "draft" ? 0 : c.sends.length,
    counts: countsOf(c),
  };
}

function detailOf(c: MockCampaign): CampaignDetail {
  const sent = countsOf(c).sent;
  return {
    ...summaryOf(c),
    results: { replied: Math.floor(sent * 0.4), appointments: Math.floor(sent * 0.2), clientsBooked: Math.floor(sent * 0.2) },
    recipients: c.sends.slice(0, 200),
  };
}

/** Avanza el envío simulado hasta "ahora". */
function advance(c: MockCampaign, businessId: string, now: number): void {
  if (c.status === "scheduled" && c.scheduledFor && Date.parse(c.scheduledFor) <= now) {
    c.status = "sending";
    c.startedAt = c.scheduledFor;
  }
  if (c.status !== "sending" || !c.startedAt) return;
  const due = Math.floor((now - Date.parse(c.startedAt)) / ENVIO_MS) + 1;
  let done = c.sends.filter((s) => s.status !== "pending").length;
  for (const s of c.sends) {
    if (done >= due) break;
    if (s.status !== "pending") continue;
    if (mockMarketingReachable(businessId, s.clientId)) {
      s.status = "sent";
      s.sentAt = new Date(Date.parse(c.startedAt) + done * ENVIO_MS).toISOString();
    } else {
      s.status = "skipped";
      s.error = "not_reachable";
    }
    done++;
  }
  if (c.sends.every((s) => s.status !== "pending")) {
    c.status = "completed";
    c.completedAt = new Date(now).toISOString();
  }
}

const STATUSES = ["new", "active", "vip", "at_risk", "inactive"];

/** Valida el segmento como CampaignSegmentInput (lo esencial). */
function readSegment(raw: unknown, fields: Record<string, string>, prefix: string): CampaignSegment {
  const segment: CampaignSegment = {};
  if (raw === undefined || raw === null) return segment;
  if (typeof raw !== "object") {
    fields[prefix] = "Segmento inválido.";
    return segment;
  }
  const statuses = field(raw, "statuses");
  if (Array.isArray(statuses)) segment.statuses = statuses.filter((s): s is NonNullable<CampaignSegment["statuses"]>[number] => STATUSES.includes(String(s)));
  const tags = field(raw, "tags");
  if (Array.isArray(tags)) segment.tags = tags.map(String).filter(Boolean);
  const vip = field(raw, "vip");
  if (typeof vip === "boolean") segment.vip = vip;
  for (const key of ["preferredLocationId", "preferredStaffId"] as const) {
    const v = field(raw, key);
    if (typeof v === "string" && v) segment[key] = v;
  }
  for (const key of ["lastVisitMinDays", "lastVisitMaxDays"] as const) {
    const v = field(raw, key);
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 3650) fields[`${prefix}.${key}`] = "Entre 1 y 3650 días.";
    else segment[key] = v;
  }
  if (segment.lastVisitMinDays && segment.lastVisitMaxDays && segment.lastVisitMinDays > segment.lastVisitMaxDays) {
    fields[`${prefix}.lastVisitMaxDays`] = "El rango de la última visita está al revés.";
  }
  const lapsed = field(raw, "lapsedService");
  if (lapsed !== undefined) {
    const serviceId = field(lapsed, "serviceId");
    const months = field(lapsed, "months");
    if (typeof serviceId !== "string" || !serviceId) fields[`${prefix}.lapsedService.serviceId`] = "Elegí el servicio.";
    else if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 60) fields[`${prefix}.lapsedService.months`] = "Entre 1 y 60 meses.";
    else segment.lapsedService = { serviceId, months };
  }
  const exclude = field(raw, "excludeUpcoming");
  if (typeof exclude === "boolean") segment.excludeUpcoming = exclude;
  return segment;
}

function readInput(body: unknown, partial: boolean): { input: Partial<Pick<MockCampaign, "name" | "message" | "segment">> } | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const out: Partial<Pick<MockCampaign, "name" | "message" | "segment">> = {};
  const name = field(body, "name");
  if (name !== undefined || !partial) {
    if (typeof name !== "string" || !name.trim()) fields["body.name"] = "Poné un nombre.";
    else if (name.trim().length > 80) fields["body.name"] = "Hasta 80 caracteres.";
    else out.name = name.trim();
  }
  const message = field(body, "message");
  if (message !== undefined || !partial) {
    if (typeof message !== "string" || !message.trim()) fields["body.message"] = "Escribí el mensaje.";
    else if (message.trim().length > MAX_MESSAGE) fields["body.message"] = `Hasta ${MAX_MESSAGE} caracteres.`;
    else if (/[\n\r\t]/.test(message)) fields["body.message"] = "El mensaje va en un solo párrafo: WhatsApp no permite saltos de línea en la variable de la plantilla.";
    else out.message = message.trim();
  }
  const segment = field(body, "segment");
  if (segment !== undefined || !partial) out.segment = readSegment(segment, fields, "body.segment");
  if (Object.keys(fields).length > 0) return { fields };
  return { input: out };
}

function audienceOf(session: MockCampaignsSession, segment: CampaignSegment) {
  return mockMarketingAudience(session.businessId, session.locations, session.industry, session.timezone, segment as MockSegment);
}

/** Rutas /campaigns* del mock. null si la ruta no es de Campañas. */
export function routeCampaignsMock(req: TransportRequest, session: MockCampaignsSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (path !== "/campaigns" && !path.startsWith("/campaigns/")) return null;
  if (!session.modules.includes("campaigns")) return fail(403, "module_not_in_plan", "Esta función no está incluida en tu plan.");
  if (!MANAGERS.includes(session.role)) return forbiddenRole();

  const state = loadState();
  const list = (state[session.businessId] ??= []);
  const now = Date.now();
  for (const c of list) advance(c, session.businessId, now);
  const result = handle(req, path, session, list, now);
  saveState(state);
  return result;
}

function handle(req: TransportRequest, path: string, session: MockCampaignsSession, list: MockCampaign[], now: number): TransportResponse {
  const { method, body } = req;

  if (method === "GET" && path === "/campaigns") {
    return ok([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summaryOf));
  }
  if (method === "GET" && path === "/campaigns/overview") {
    mockClientsOf(session.businessId, session.locations);
    const all = audienceOf(session, {});
    return ok({
      consent: { clients: all.matched, consented: all.eligible + all.withoutPhone, optedOut: all.optedOut },
      channels: session.channels(),
    });
  }
  if (method === "POST" && path === "/campaigns/preview") {
    const fields: Record<string, string> = {};
    const segment = readSegment(field(body, "segment"), fields, "body.segment");
    if (Object.keys(fields).length > 0) return invalid(fields);
    const a = audienceOf(session, segment);
    return ok({
      matched: a.matched,
      eligible: a.eligible,
      withoutConsent: a.withoutConsent,
      optedOut: a.optedOut,
      withoutPhone: a.withoutPhone,
      sample: a.recipients.slice(0, 5),
      channels: session.channels(),
    });
  }
  if (method === "POST" && path === "/campaigns") {
    const read = readInput(body, false);
    if ("fields" in read) return invalid(read.fields);
    const created: MockCampaign = {
      id: `ca000000-0000-4000-8000-${String(now % 1e12).padStart(12, "0")}`,
      name: read.input.name as string,
      message: read.input.message as string,
      segment: read.input.segment ?? {},
      status: "draft",
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(now).toISOString(),
      sends: [],
    };
    list.push(created);
    return ok(detailOf(created), 201);
  }

  const match = /^\/campaigns\/([^/]+)(?:\/(launch|cancel))?$/.exec(path);
  if (!match) return fail(404, "not_found", "Ruta inexistente en el mock.");
  const campaign = list.find((c) => c.id === decodeURIComponent(match[1]));
  if (!campaign) return fail(404, "not_found", "Esa campaña no existe.");
  const action = match[2];
  const notDraft = () => fail(409, "campaign_not_draft", "La campaña ya se lanzó: no se puede cambiar.");

  if (method === "GET" && !action) return ok(detailOf(campaign));
  if (method === "PATCH" && !action) {
    if (campaign.status !== "draft") return notDraft();
    const read = readInput(body, true);
    if ("fields" in read) return invalid(read.fields);
    Object.assign(campaign, read.input);
    return ok(detailOf(campaign));
  }
  if (method === "DELETE" && !action) {
    if (campaign.status !== "draft") return notDraft();
    list.splice(list.indexOf(campaign), 1);
    return { status: 204, payload: undefined };
  }
  if (method === "POST" && action === "launch") {
    if (campaign.status !== "draft") return notDraft();
    const raw = field(body, "scheduledFor");
    const at = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (raw !== undefined && raw !== null && Number.isNaN(at)) return invalid({ "body.scheduledFor": "Fecha inválida." });
    const scheduled = !Number.isNaN(at) && at > now ? at : null;
    if (scheduled && scheduled > now + 90 * 86_400_000) return fail(400, "invalid_schedule", "Se puede programar hasta 90 días adelante.");
    const channels = session.channels();
    if (channels.withTemplate === 0) {
      return fail(
        409,
        "no_marketing_template",
        channels.connected === 0
          ? "Conectá un número de WhatsApp para mandar campañas."
          : "Cargá la plantilla de marketing aprobada por Meta en WhatsApp IA › Configuración › Números.",
      );
    }
    const audience = audienceOf(session, campaign.segment);
    if (audience.eligible === 0) return fail(409, "empty_audience", "Nadie de ese segmento aceptó recibir promociones todavía: no hay a quién mandarle.");
    campaign.sends = audience.recipients.map((r) => ({ clientId: r.id, name: r.name, status: "pending", error: null, sentAt: null }));
    campaign.status = scheduled ? "scheduled" : "sending";
    campaign.scheduledFor = scheduled ? new Date(scheduled).toISOString() : null;
    campaign.startedAt = scheduled ? null : new Date(now).toISOString();
    return ok(detailOf(campaign));
  }
  if (method === "POST" && action === "cancel") {
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      return fail(409, "campaign_finished", campaign.status === "completed" ? "La campaña ya terminó." : "La campaña ya estaba cancelada.");
    }
    campaign.status = "cancelled";
    campaign.completedAt = new Date(now).toISOString();
    for (const s of campaign.sends) {
      if (s.status === "pending") {
        s.status = "skipped";
        s.error = "cancelled";
      }
    }
    return ok(detailOf(campaign));
  }
  return fail(405, "method_not_allowed", "Método no permitido.");
}
