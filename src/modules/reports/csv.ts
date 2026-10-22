import type { AnyReport, ChannelsReport, ClientsReport, ReportId, SalesReport, ServicesReport, StaffReport } from "./reports";

// ─────────────────────────────────────────────────────────────────────────────
// Exportación CSV de los reportes (`GET /reports/:report.csv`), RFC 4180:
//
//   • UTF-8 con BOM (Excel abre bien las tildes), separador coma, fin de línea CRLF.
//   • Un campo va entre comillas si trae coma, comillas o salto de línea; las comillas se
//     duplican.
//   • Inyección de fórmulas: un TEXTO que empieza con = + - @ (o tab/CR) se prefija con
//     un apóstrofo, así una planilla no lo ejecuta (un cliente o servicio llamado
//     "=HYPERLINK(…)" sale como texto). Los números no se tocan (un -1500 o "-15.00"
//     siguen siendo números).
//   • Montos en unidades de la moneda con dos decimales y punto ("25000.00"); porcentajes
//     con un decimal ("37.5"); la moneda va en el encabezado.
// ─────────────────────────────────────────────────────────────────────────────

export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
/** Un número escrito como texto ("-15.00") no es una fórmula: no se prefija. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Un campo CSV escapado. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Documento CSV completo (con BOM) a partir del encabezado y las filas. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Céntimos → unidades con dos decimales ("25000.00"); negativo con signo. */
export const money = (cents: number): string => (cents / 100).toFixed(2);

/** Proporción (0–1) → porcentaje con un decimal; vacío si no hay base. */
export const percent = (value: number | null): string => (value === null ? "" : (Math.round(value * 1000) / 10).toFixed(1));

/** Nombre del archivo: `reporte-ventas_2026-10-01_2026-10-30.csv`. */
export function csvFileName(report: ReportId, from: string, to: string): string {
  return `reporte-${CSV_NAMES[report]}_${from}_${to}.csv`;
}

const CSV_NAMES: Record<ReportId, string> = {
  sales: "ventas",
  services: "servicios",
  staff: "profesionales",
  clients: "clientes",
  channels: "canales",
};

function salesCsv(r: SalesReport): string {
  const c = r.currency;
  return toCsv(
    ["Fecha", `Cobrado (${c})`, `Devoluciones (${c})`, `Neto (${c})`, "Movimientos"],
    r.byDay.map((d) => [d.date, money(d.collectedCents), money(d.refundsCents), money(d.netCents), d.count]),
  );
}

function servicesCsv(r: ServicesReport): string {
  const c = r.currency;
  return toCsv(
    ["Servicio", "Agendados", "Realizados", `Valor realizado (${c})`, `Cobrado neto (${c})`],
    r.items.map((i) => [i.name, i.scheduled, i.completed, money(i.completedValueCents), money(i.collectedNetCents)]),
  );
}

function staffCsv(r: StaffReport): string {
  const c = r.currency;
  return toCsv(
    [
      "Profesional",
      "Citas",
      "Completadas",
      "No asistió",
      "Canceladas",
      "% no-show",
      `Cobrado neto (${c})`,
      "Minutos agendados",
      "Minutos disponibles",
      "% ocupación",
      `Comisiones (${c})`,
    ],
    r.items.map((i) => [
      i.name,
      i.appointments,
      i.completed,
      i.noShow,
      i.cancelled,
      percent(i.noShowRate),
      money(i.collectedNetCents),
      i.bookedMinutes,
      i.availableMinutes,
      percent(i.occupancyRate),
      money(i.commissionCents),
    ]),
  );
}

function clientsCsv(r: ClientsReport): string {
  return toCsv(
    ["Fecha", "Clientes nuevos", "Clientes recurrentes"],
    r.byDay.map((d) => [d.date, d.newClients, d.returningClients]),
  );
}

function channelsCsv(r: ChannelsReport): string {
  const c = r.currency;
  return toCsv(
    ["Canal", "Citas", "Completadas", "Canceladas", "No asistió", `Valor completadas (${c})`, `Cobrado neto (${c})`],
    r.items.map((i) => [i.label, i.appointments, i.completed, i.cancelled, i.noShow, money(i.completedValueCents), money(i.collectedNetCents)]),
  );
}

/** CSV de un reporte ya armado. */
export function reportToCsv(id: ReportId, report: AnyReport): string {
  switch (id) {
    case "sales":
      return salesCsv(report as SalesReport);
    case "services":
      return servicesCsv(report as ServicesReport);
    case "staff":
      return staffCsv(report as StaffReport);
    case "clients":
      return clientsCsv(report as ClientsReport);
    case "channels":
      return channelsCsv(report as ChannelsReport);
  }
}
