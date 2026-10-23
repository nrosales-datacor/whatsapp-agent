import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { route } from "../../platform/http/router";
import type { Route, Session } from "../../platform/http/routeTypes";
import type { ConversationsWaitingCounter } from "../scheduling";
import { csvFileName, reportToCsv } from "./csv";
import { getHomeOverview } from "./home";
import { ReportQuery, resolveReportScope } from "./range";
import { REPORT_BUILDERS, REPORT_IDS } from "./reports";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Reportes e Inicio completo (I5, plan Pro: `module: "reports"`):
//
//   GET /reports/sales         ingresos cobrados por día, método y sucursal; ticket
//                              promedio; señas y devoluciones
//   GET /reports/services      más vendidos por cantidad e ingresos
//   GET /reports/staff         citas, completadas, no-show %, cobrado, ocupación %, comisiones
//   GET /reports/clients       nuevos, recurrentes, altas, retención simple y la cartera
//                              por estado del CRM (hoy)
//   GET /reports/channels      agente de WhatsApp, panel, teléfono, presencial, web
//   GET /reports/<id>.csv      el mismo reporte para exportar (descarga)
//        ?from&to (días locales AAAA-MM-DD, inclusive, zona del negocio)&locationId
//        → dueño y admin (Reportes es de quien maneja el negocio, PLAN-GESTION.md §6)
//
//   GET /home/overview         Inicio completo (dueño, admin y recepción; sucursal por
//                              X-Location-Id o todas). El Básico usa /home/today.
//
// Sucursal: `locationId` de la query, o el header `X-Location-Id`, o todas las de la
// sesión; una sesión limitada a algunas sucursales no ve las otras (403).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportsRouteDeps {
  db: Executor;
  /** Conversaciones esperando a una persona para el Inicio (lo inyecta la composición desde whatsapp). */
  countConversationsWaiting?: ConversationsWaitingCounter;
}

const MANAGERS: readonly Role[] = ["owner", "admin"];
const DESK: readonly Role[] = ["owner", "admin", "front_desk"];

/** Sucursales que ve la sesión en el Inicio: la del header, o todas las suyas (null = todas las del negocio). */
function visibleLocations(session: Session, headerLocation: string | null): readonly string[] | null {
  if (headerLocation) return [headerLocation];
  return session.locationIds === "all" ? null : session.locationIds;
}

export function reportsRoutes({ db, countConversationsWaiting }: ReportsRouteDeps): Route[] {
  const reportRoutes = REPORT_IDS.flatMap((id) => [
    route(
      { method: "GET", path: `/reports/${id}`, auth: "user", roles: MANAGERS, module: "reports", location: "optional", query: ReportQuery },
      async ({ session, query, locationId }) => {
        const scope = await resolveReportScope(db, session, query, locationId);
        return REPORT_BUILDERS[id](db, session.businessId, scope);
      },
    ),
    route(
      { method: "GET", path: `/reports/${id}.csv`, auth: "user", roles: MANAGERS, module: "reports", location: "optional", query: ReportQuery },
      async ({ session, query, locationId, res, log }) => {
        const scope = await resolveReportScope(db, session, query, locationId);
        const report = await REPORT_BUILDERS[id](db, session.businessId, scope);
        const body = reportToCsv(id, report);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${csvFileName(id, scope.view.from, scope.view.to)}"`,
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        log.info("report_exported", { report: id, days: scope.view.days });
      },
    ),
  ]);

  return [
    ...reportRoutes,
    route(
      { method: "GET", path: "/home/overview", auth: "user", roles: DESK, module: "reports", location: "optional" },
      ({ session, locationId }) =>
        getHomeOverview(db, session.businessId, { locationIds: visibleLocations(session, locationId), locationId, countConversationsWaiting }),
    ),
  ];
}
