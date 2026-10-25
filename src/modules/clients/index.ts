// API pública del módulo clients: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). La usan la Agenda (citas, historial), Ventas
// (caché de gasto), el agente de WhatsApp (buscar o crear por teléfono) y, en I6, Campañas
// (los filtros de la lista como segmentos: `listClients`/`iterateClients` + `ClientFiltersQuery`).
export { normalizePhone } from "./phone";
export { clientsRoutes, ClientFiltersQuery, filtersFromQuery, type ClientsRouteDeps, type StaffClientsQuery } from "./routes";
export {
  CLIENT_SORTS,
  countClientsByStatus,
  iterateClients,
  listClients,
  listClientTags,
  type ClientFilters,
  type ClientPage,
  type ClientSort,
  type ClientStatusCounts,
  type ClientSummary,
  type ListClientsInput,
  type ListClientsOptions,
} from "./search";
export { CLIENT_STATUSES, computeClientStatus, isVip, type ClientStatus, type ClientStatusInput } from "./status";
// Consentimiento de marketing y audiencia de las campañas (I6).
export {
  claimMarketingConsentRequest,
  listMarketingAudienceIds,
  MAX_CAMPAIGN_AUDIENCE,
  marketingConsentSummary,
  marketingRecipient,
  previewMarketingAudience,
  recordMarketingConsent,
  type AudienceOptions,
  type MarketingAudience,
  type MarketingRecipient,
} from "./marketing";
export {
  ANONYMIZED_CLIENT_NAME,
  clientIdIn,
  findClientByPhone,
  findOrCreateClientByPhone,
  getClient,
  getClientsByIds,
  recordMarketingOptOut,
  refreshClientStats,
  UNNAMED_CLIENT,
} from "./service";
export type { ClientDataEraser, ClientDetail, ClientRef, ClientScope, ClientStats, ClientView, FindOrCreateInput } from "./service";
// Reportes e Inicio completo (I5): altas en un rango y clientes en riesgo (estado `at_risk` del CRM).
export { countRegisteredClients, listClientsAtRisk, type AtRiskClient, type AtRiskClients } from "./stats";
export type { Client, ClientChannel, NewClient } from "./schema";
