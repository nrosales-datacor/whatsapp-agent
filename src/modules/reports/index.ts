// API pública del módulo reports (I5): Reportes del Pro (ventas, servicios, profesionales,
// clientes y canales, con exportación CSV) e Inicio completo. Solo lectura y sin tablas:
// arma todo con los agregados SQL que exponen los demás módulos por su index.ts. Depende
// del núcleo; NADIE depende de reports (lo verifica test/architecture/moduleBoundaries).
export { csvCell, csvFileName, money, percent, reportToCsv, toCsv, type CsvCell } from "./csv";
export { getHomeOverview, REVENUE_DAYS, type HomeOverview } from "./home";
export { DEFAULT_REPORT_DAYS, MAX_REPORT_DAYS, ReportQuery, resolveReportScope, type RangeView, type ReportScope } from "./range";
export {
  buildChannelsReport,
  buildClientsReport,
  buildSalesReport,
  buildServicesReport,
  buildStaffReport,
  REPORT_BUILDERS,
  REPORT_IDS,
} from "./reports";
export type {
  AnyReport,
  ChannelReportItem,
  ChannelsReport,
  ClientsReport,
  ReportId,
  SalesReport,
  ServiceReportItem,
  ServicesReport,
  StaffReport,
  StaffReportItem,
} from "./reports";
export { reportsRoutes, type ReportsRouteDeps } from "./routes";
