// API pública del módulo campaigns: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I6.
export type {
  Campaign,
  CampaignSend,
  CampaignSendStatus,
  CampaignStatus,
  NewCampaign,
  NewCampaignSend,
  SegmentFilter,
  SegmentType,
} from "./schema";
