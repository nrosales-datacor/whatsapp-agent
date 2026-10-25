import { z } from "zod";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { created, noContent, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { CampaignSegmentInput } from "./segment";
import {
  campaignsOverview,
  CampaignInput,
  CampaignPatch,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  launchCampaign,
  LaunchInput,
  listCampaigns,
  previewSegment,
  updateCampaign,
} from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Campañas (módulo del plan `campaigns`: Pro, o extra del Básico). Dueño y admin.
//
//   GET    /campaigns                 lista con conteos de envíos
//   GET    /campaigns/overview        consentimiento de la cartera y estado de los números
//   POST   /campaigns/preview         { segment } → cuántos la reciben y cuántos quedan afuera
//   POST   /campaigns                 borrador { name, message, segment }
//   GET    /campaigns/:id             detalle con resultados y destinatarios
//   PATCH  /campaigns/:id             editar el borrador
//   DELETE /campaigns/:id             borrar el borrador
//   POST   /campaigns/:id/launch      { scheduledFor? } lanzar ya o programar
//   POST   /campaigns/:id/cancel      cancelar lo que falte
//
// El consentimiento dado en persona se registra en la ficha (PUT /clients/:id/marketing-consent).
// ─────────────────────────────────────────────────────────────────────────────

const MANAGERS: readonly Role[] = ["owner", "admin"];
const MODULE = "campaigns";
const IdParams = z.object({ id: z.uuid() });
const PreviewBody = z.object({ segment: CampaignSegmentInput }).strict();

export interface CampaignsRouteDeps {
  db: Executor;
}

export function campaignsRoutes({ db }: CampaignsRouteDeps): Route[] {
  const base = { auth: "user", roles: MANAGERS, module: MODULE } as const;
  return [
    route({ ...base, method: "GET", path: "/campaigns" }, ({ session }) => listCampaigns(db, session.businessId)),
    route({ ...base, method: "GET", path: "/campaigns/overview" }, ({ session }) => campaignsOverview(db, session.businessId)),
    route({ ...base, method: "POST", path: "/campaigns/preview", body: PreviewBody }, ({ session, body }) => previewSegment(db, session.businessId, body.segment)),
    route({ ...base, method: "POST", path: "/campaigns", body: CampaignInput }, async ({ session, body }) =>
      created(await createCampaign(db, session.businessId, body, session.userId)),
    ),
    route({ ...base, method: "GET", path: "/campaigns/:id", params: IdParams }, ({ session, params }) => getCampaign(db, session.businessId, params.id)),
    route({ ...base, method: "PATCH", path: "/campaigns/:id", params: IdParams, body: CampaignPatch }, ({ session, params, body }) =>
      updateCampaign(db, session.businessId, params.id, body),
    ),
    route({ ...base, method: "DELETE", path: "/campaigns/:id", params: IdParams }, async ({ session, params }) => {
      await deleteCampaign(db, session.businessId, params.id);
      return noContent();
    }),
    route({ ...base, method: "POST", path: "/campaigns/:id/launch", params: IdParams, body: LaunchInput }, async ({ session, params, body, log }) => {
      const campaign = await launchCampaign(db, session.businessId, params.id, {
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        userId: session.userId,
      });
      log.info("campaign_launched", { campaignId: campaign.id, recipients: campaign.totalRecipients, status: campaign.status });
      return campaign;
    }),
    route({ ...base, method: "POST", path: "/campaigns/:id/cancel", params: IdParams }, ({ session, params }) =>
      cancelCampaign(db, session.businessId, params.id, session.userId),
    ),
  ];
}
