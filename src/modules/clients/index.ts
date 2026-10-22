// API pública del módulo clients: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). La usan la Agenda (citas, historial), Ventas
// (caché de gasto) y el agente de WhatsApp (buscar o crear por teléfono).
export { normalizePhone } from "./phone";
export { clientsRoutes, type ClientsRouteDeps } from "./routes";
export { listClients, type ClientPage, type ClientSort, type ClientSummary, type ListClientsInput } from "./search";
export {
  ANONYMIZED_CLIENT_NAME,
  findClientByPhone,
  findOrCreateClientByPhone,
  getClient,
  getClientsByIds,
  recordMarketingOptOut,
  refreshClientStats,
  UNNAMED_CLIENT,
} from "./service";
export type { ClientDataEraser, ClientDetail, ClientRef, ClientStats, ClientView, FindOrCreateInput } from "./service";
// Reportes e Inicio completo (I5): altas en un rango y clientes en riesgo (provisorio, TODO(I3)).
export { countRegisteredClients, listClientsAtRisk, type AtRiskClient, type AtRiskClients } from "./stats";
export type { Client, ClientChannel, NewClient } from "./schema";
