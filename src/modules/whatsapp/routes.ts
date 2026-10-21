import { z } from "zod";
import type { Role } from "../../platform/auth/sessionToken";
import { superadminActor, userActor } from "../../platform/audit/auditLog";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { created, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { log } from "../../platform/observability/log";
import { connectChannel, createChannelByAdmin, listChannels, testChannel, updateChannel } from "./channels";
import type { WhatsAppDeps } from "./deps";
import { embeddedSignupConfig } from "./graph";
import {
  agentMetrics,
  changeMode,
  changeStatus,
  getConversationDetail,
  inboxSummary,
  listConversations,
  markConversationRead,
  reopenConversation,
  sendHumanMessage,
  visibleLocations,
} from "./inbox";
import { AUTH_PATTERN, isAllowedPushEndpoint, P256DH_PATTERN, removePushSubscription, savePushSubscription, sendPushToBusiness, vapidPublicKey } from "./push";
import { reprocessForPhoneNumber } from "./webhook";

// ─────────────────────────────────────────────────────────────────────────────
// API del módulo WhatsApp (todas con `module: "whatsapp"`, salvo el alta del superadmin).
//
//   Canales (dueño, admin)
//     GET   /whatsapp/channels                  números conectados (sin el token)
//     GET   /whatsapp/channels/signup-config    { appId, configId, graphVersion } del Embedded Signup
//     POST  /whatsapp/channels/connect          { code, phoneNumberId?, wabaId?, locationId? }
//     POST  /whatsapp/channels/:id/test         prueba el token contra Meta
//     PATCH /whatsapp/channels/:id              { locationId?, templates? }
//   Superadmin
//     POST  /admin/businesses/:id/whatsapp      alta manual { phoneNumberId, accessToken?, … }
//   Bandeja (dueño, admin, recepción; X-Location-Id opcional)
//     GET   /whatsapp/conversations             ?status=open|attended|all&q&cursor
//     GET   /whatsapp/conversations/:id         ?before
//     POST  /whatsapp/conversations/:id/messages { text }  (409 window_closed fuera de las 24 h)
//     POST  /whatsapp/conversations/:id/mode     { mode: bot|human }
//     POST  /whatsapp/conversations/:id/status   { status: open|attended }
//     POST  /whatsapp/conversations/:id/read
//     POST  /whatsapp/conversations/:id/reopen   plantilla de reapertura
//     GET   /whatsapp/summary  ·  GET /whatsapp/metrics?from&to
//   Push (dueño, admin, recepción)
//     GET   /push/public-key  ·  POST /push/subscribe  ·  POST /push/unsubscribe  ·  POST /push/test
//
// `GET/PATCH /whatsapp/settings` (configuración del agente) los monta el agente de IA.
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsAppRouteDeps {
  db: Executor;
  deps: WhatsAppDeps;
}

const ADMINS: readonly Role[] = ["owner", "admin"];
const DESK: readonly Role[] = ["owner", "admin", "front_desk"];
const MODULE = "whatsapp";

const IdParams = z.object({ id: z.uuid() });
const MetaId = z.string().trim().regex(/^\d{5,30}$/, "Identificador de Meta inválido (solo dígitos).");

const Template = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Nombre de plantilla inválido (minúsculas, dígitos y _)."),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Idioma inválido (p. ej. es o es_MX)."),
  })
  .strict();

const PatchChannelBody = z
  .object({
    locationId: z.uuid().nullable().optional(),
    templates: z
      .object({ reminder: Template.nullable().optional(), reopen: Template.nullable().optional(), marketing: Template.nullable().optional() })
      .strict()
      .optional(),
  })
  .strict();

const ConnectBody = z
  .object({ code: z.string().trim().min(1).max(2000), phoneNumberId: MetaId.optional(), wabaId: MetaId.optional(), locationId: z.uuid().nullable().optional() })
  .strict();

const AdminChannelBody = z
  .object({
    phoneNumberId: MetaId,
    wabaId: MetaId.nullable().optional(),
    displayPhone: z.string().trim().max(40).nullable().optional(),
    accessToken: z.string().trim().min(20).max(2000).nullable().optional(),
    locationId: z.uuid().nullable().optional(),
  })
  .strict();

const ListQuery = z.object({
  status: z.enum(["open", "attended", "all"]).default("open"),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const DetailQuery = z.object({ before: z.string().max(500).optional() });
const MessageBody = z.object({ text: z.string().trim().min(1, "El mensaje está vacío.").max(4096, "WhatsApp acepta hasta 4096 caracteres.") }).strict();
const ModeBody = z.object({ mode: z.enum(["bot", "human"]) }).strict();
const StatusBody = z.object({ status: z.enum(["open", "attended"]) }).strict();
const MetricsQuery = z.object({
  from: z.iso.date("Fecha inválida (AAAA-MM-DD).").optional(),
  to: z.iso.date("Fecha inválida (AAAA-MM-DD).").optional(),
});

const SubscribeBody = z.object({
  endpoint: z.string().trim().max(1024).refine(isAllowedPushEndpoint, "Servicio de notificaciones no permitido."),
  keys: z.object({ p256dh: z.string().regex(P256DH_PATTERN, "Suscripción inválida."), auth: z.string().regex(AUTH_PATTERN, "Suscripción inválida.") }),
});
const UnsubscribeBody = z.object({ endpoint: z.string().trim().max(1024) });

/** Reprocesa en segundo plano lo que llegó para un número antes de conectarlo. */
function reprocessLater(db: Executor, phoneNumberId: string): void {
  void reprocessForPhoneNumber(db, phoneNumberId).catch((e) =>
    log.warn("whatsapp_raw_reprocess_after_connect_failed", { error: e instanceof Error ? e.message : String(e) }),
  );
}

export function whatsappRoutes({ db, deps }: WhatsAppRouteDeps): Route[] {
  return [
    // ── Canales ──
    route({ method: "GET", path: "/whatsapp/channels", auth: "user", roles: ADMINS, module: MODULE }, ({ session }) => listChannels(db, session.businessId)),

    route({ method: "GET", path: "/whatsapp/channels/signup-config", auth: "user", roles: ADMINS, module: MODULE }, () => {
      const config = embeddedSignupConfig();
      if (!config) throw new HttpError(503, "La conexión automática con Meta todavía no está configurada.", "signup_not_configured");
      return config;
    }),

    route(
      { method: "POST", path: "/whatsapp/channels/connect", auth: "user", roles: ADMINS, module: MODULE, body: ConnectBody },
      async ({ session, body }) => {
        const channel = await connectChannel(db, deps.api, userActor(session.userId), session.businessId, body);
        reprocessLater(db, channel.phoneNumberId);
        return created(channel);
      },
    ),

    route(
      { method: "POST", path: "/whatsapp/channels/:id/test", auth: "user", roles: ADMINS, module: MODULE, params: IdParams },
      ({ session, params }) => testChannel(db, deps.api, session.businessId, params.id),
    ),

    route(
      { method: "PATCH", path: "/whatsapp/channels/:id", auth: "user", roles: ADMINS, module: MODULE, params: IdParams, body: PatchChannelBody },
      ({ session, params, body }) => updateChannel(db, session.businessId, params.id, body),
    ),

    route(
      { method: "POST", path: "/admin/businesses/:id/whatsapp", auth: "superadmin", params: IdParams, body: AdminChannelBody },
      async ({ session, params, body }) => {
        const channel = await createChannelByAdmin(db, superadminActor(session.adminId), params.id, body);
        reprocessLater(db, channel.phoneNumberId);
        return created(channel);
      },
    ),

    // ── Bandeja ──
    route(
      { method: "GET", path: "/whatsapp/conversations", auth: "user", roles: DESK, module: MODULE, location: "optional", query: ListQuery },
      ({ session, locationId, query }) =>
        listConversations(db, session.businessId, { ...query, locations: visibleLocations(session.locationIds, locationId), now: deps.now() }),
    ),

    route(
      { method: "GET", path: "/whatsapp/conversations/:id", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams, query: DetailQuery },
      ({ session, locationId, params, query }) =>
        getConversationDetail(db, deps, session.businessId, params.id, {
          before: query.before,
          locations: visibleLocations(session.locationIds, locationId),
          now: deps.now(),
        }),
    ),

    route(
      { method: "POST", path: "/whatsapp/conversations/:id/messages", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams, body: MessageBody },
      async ({ session, locationId, params, body }) =>
        created(await sendHumanMessage(db, deps, session.businessId, params.id, { text: body.text, locations: visibleLocations(session.locationIds, locationId) })),
    ),

    route(
      { method: "POST", path: "/whatsapp/conversations/:id/mode", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams, body: ModeBody },
      ({ session, locationId, params, body }) =>
        changeMode(db, session.businessId, params.id, { mode: body.mode, locations: visibleLocations(session.locationIds, locationId), now: deps.now() }),
    ),

    route(
      { method: "POST", path: "/whatsapp/conversations/:id/status", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams, body: StatusBody },
      ({ session, locationId, params, body }) =>
        changeStatus(db, session.businessId, params.id, { status: body.status, locations: visibleLocations(session.locationIds, locationId), now: deps.now() }),
    ),

    route(
      { method: "POST", path: "/whatsapp/conversations/:id/read", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams },
      ({ session, locationId, params }) =>
        markConversationRead(db, session.businessId, params.id, { locations: visibleLocations(session.locationIds, locationId), now: deps.now() }),
    ),

    route(
      { method: "POST", path: "/whatsapp/conversations/:id/reopen", auth: "user", roles: DESK, module: MODULE, location: "optional", params: IdParams },
      ({ session, locationId, params }) =>
        reopenConversation(db, deps, session.businessId, params.id, { locations: visibleLocations(session.locationIds, locationId) }),
    ),

    route({ method: "GET", path: "/whatsapp/summary", auth: "user", roles: DESK, module: MODULE, location: "optional" }, ({ session, locationId }) =>
      inboxSummary(db, session.businessId, { locations: visibleLocations(session.locationIds, locationId), locationId, now: deps.now() }),
    ),

    route(
      { method: "GET", path: "/whatsapp/metrics", auth: "user", roles: DESK, module: MODULE, location: "optional", query: MetricsQuery },
      ({ session, locationId, query }) =>
        agentMetrics(db, session.businessId, { ...query, locations: visibleLocations(session.locationIds, locationId), locationId, now: deps.now() }),
    ),

    // ── Push ──
    route({ method: "GET", path: "/push/public-key", auth: "user", roles: DESK, module: MODULE }, () => ({ key: vapidPublicKey() })),

    route(
      { method: "POST", path: "/push/subscribe", auth: "user", roles: DESK, module: MODULE, body: SubscribeBody },
      async ({ session, body }) => {
        await savePushSubscription(db, session, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth });
        return { subscribed: true };
      },
    ),

    route(
      { method: "POST", path: "/push/unsubscribe", auth: "user", roles: DESK, module: MODULE, body: UnsubscribeBody },
      async ({ session, body }) => ({ removed: await removePushSubscription(db, session, body.endpoint) }),
    ),

    route({ method: "POST", path: "/push/test", auth: "user", roles: DESK, module: MODULE }, async ({ session }) => {
      const transport = deps.push();
      if (!transport) throw new HttpError(503, "Las notificaciones push no están configuradas en el servidor.", "push_not_configured");
      return sendPushToBusiness(
        db,
        session.businessId,
        { title: "🔔 Notificaciones activas", body: "Así te vamos a avisar cuando una conversación necesite a una persona.", url: "/panel/whatsapp" },
        { transport, onlyUserId: session.userId },
      );
    }),
  ];
}
