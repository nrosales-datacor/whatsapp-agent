// API pública del módulo campaigns (I6): lo único que otros módulos y la composición pueden
// importar de acá (test/architecture/moduleBoundaries.test.ts). La composición monta las
// rutas (src/routes.ts) y registra el despacho en la cola (src/jobs.ts) con el envío del
// módulo WhatsApp.
export { handleCampaignDispatchJob, type DispatchDeps, type DispatchOutcome } from "./dispatch";
export { campaignsRoutes, type CampaignsRouteDeps } from "./routes";
export {
  CAMPAIGN_DISPATCH_JOB,
  cancelCampaign,
  createCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  previewSegment,
  type CampaignDetail,
  type CampaignDispatchPayload,
  type CampaignSummary,
  type CampaignsOverview,
  type SendCounts,
} from "./service";
export type {
  Campaign,
  CampaignSegment,
  CampaignSend,
  CampaignSendStatus,
  CampaignStatus,
  NewCampaign,
  NewCampaignSend,
} from "./schema";
