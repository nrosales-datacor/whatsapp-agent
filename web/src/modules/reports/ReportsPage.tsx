import { useState } from "react";
import { Link, Navigate, Outlet, useLocation, useOutletContext, useSearchParams } from "react-router-dom";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import { todayIn } from "../scheduling/format";
import { shiftDate } from "../sales/format";
import { rangeLabel } from "./format";
import { reportsApi, type ReportId, type ReportRange } from "./reportsApi";
// Clases compartidas: tablas, KPIs y pestañas de Ventas; carga y avisos de Clientes.
import "../clients/clients.css";
import "../sales/sales.css";
import "./reports.css";

// ─────────────────────────────────────────────────────────────────────────────
// Reportes (/reports/*, PLAN-GESTION.md §6, plan Pro): Ventas · Servicios · Profesionales ·
// Clientes · Canales. Arriba, el período (7, 30 o 90 días, o personalizado) y la sucursal;
// cada pestaña lo conserva en la URL (?days=30 o ?from&to) para poder compartir el enlace.
// "Exportar CSV" baja la pestaña activa con el mismo período y sucursal. La guarda del
// módulo (plan y rol: dueño y admin) es la de la sección, en App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

interface Tab {
  id: ReportId;
  path: string;
  label: string;
}

const PRESETS = [7, 30, 90] as const;
type Preset = (typeof PRESETS)[number] | "custom";

export interface ReportsOutletContext {
  range: ReportRange;
  valid: boolean;
}

/** Período y validez que comparte el layout con la pestaña. */
export function useReportRange(): ReportsOutletContext {
  return useOutletContext<ReportsOutletContext>();
}

function tabsFor(staffLabel: string, clientsLabel: string): Tab[] {
  return [
    { id: "sales", path: "/reports", label: "Ventas" },
    { id: "services", path: "/reports/services", label: "Servicios" },
    { id: "staff", path: "/reports/staff", label: staffLabel },
    { id: "clients", path: "/reports/clients", label: clientsLabel },
    { id: "channels", path: "/reports/channels", label: "Canales" },
  ];
}

function activeTab(tabs: Tab[], pathname: string): Tab | undefined {
  const clean = pathname.replace(/\/+$/, "");
  return tabs.find((t) => t.path !== "/reports" && clean.endsWith(t.path)) ?? (clean.endsWith("/reports") ? tabs[0] : undefined);
}

export default function ReportsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const { selected, label, locations, canSelectAll, allLabel, select } = useActiveLocation();
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);
  const tabs = tabsFor(capitalize(t.staff), capitalize(t.clients));
  const current = activeTab(tabs, pathname);

  const today = todayIn(me.business.timezone);
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const daysParam = Number(params.get("days"));
  const preset: Preset = customFrom || customTo ? "custom" : PRESETS.includes(daysParam as (typeof PRESETS)[number]) ? (daysParam as Preset) : 30;
  const range: ReportRange =
    preset === "custom" ? { from: customFrom ?? shiftDate(today, -29), to: customTo ?? today } : { from: shiftDate(today, -(preset - 1)), to: today };
  const valid = Boolean(range.from && range.to && range.from <= range.to);
  const tooLong = valid && shiftDate(range.from, 366) <= range.to;

  if (!current) return <Navigate to={{ pathname: "/reports", search: params.toString() }} replace />;

  function choosePreset(next: Preset) {
    if (next === "custom") setParams({ from: range.from, to: range.to }, { replace: true });
    else setParams({ days: String(next) }, { replace: true });
  }

  function setCustom(key: "from" | "to", value: string) {
    setParams({ from: key === "from" ? value : range.from, to: key === "to" ? value : range.to }, { replace: true });
  }

  async function exportCsv() {
    if (!current || !valid || tooLong) return;
    setExporting(true);
    try {
      const name = await reportsApi.exportCsv(current.id, range);
      showToast(`Listo: se descargó ${name}.`);
    } catch (error) {
      showToast(errorMessage(error, "No pudimos exportar el reporte."));
    } finally {
      setExporting(false);
    }
  }

  const locationOptions = [...(canSelectAll ? [{ value: ALL_LOCATIONS, label: allLabel }] : []), ...locations.map((l) => ({ value: l.id, label: l.name }))];
  const search = params.toString();

  return (
    <div className="page sales-page rp-page">
      <div className="sales-head">
        <PageHeader
          title="Reportes"
          tabTitle={`${current.label} · Reportes`}
          subtitle={`${rangeLabel(range.from, range.to)} · ${selected === ALL_LOCATIONS ? label : `${capitalize(t.location)}: ${label}`}`}
        />
        <nav className="sales-tabs" aria-label="Secciones de Reportes">
          <ul>
            {tabs.map((tab) => (
              <li key={tab.id}>
                <Link
                  to={{ pathname: tab.path, search }}
                  className={"sales-tab" + (tab.id === current.id ? " active" : "")}
                  aria-current={tab.id === current.id ? "page" : undefined}
                >
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="sales-toolbar rp-toolbar">
        <fieldset className="rp-presets">
          <legend className="field-label">Período</legend>
          <div className="rp-presets-options">
            {[...PRESETS, "custom" as const].map((p) => (
              <label key={p} className={"rp-preset" + (preset === p ? " active" : "")}>
                <input type="radio" name="report-period" value={String(p)} checked={preset === p} onChange={() => choosePreset(p)} />
                {p === "custom" ? "Personalizado" : `${p} días`}
              </label>
            ))}
          </div>
        </fieldset>
        {preset === "custom" && (
          <>
            <TextField label="Desde" type="date" value={range.from} max={range.to} onChange={(e) => setCustom("from", e.target.value)} />
            <TextField label="Hasta" type="date" value={range.to} min={range.from} max={today} onChange={(e) => setCustom("to", e.target.value)} />
          </>
        )}
        {locationOptions.length > 1 && (
          <SelectField label={capitalize(t.location)} value={selected} onChange={(e) => select(e.target.value)} options={locationOptions} />
        )}
        <div className="sales-toolbar-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void exportCsv()} disabled={exporting || !valid || tooLong}>
            <Icon id="receipt" size={16} />
            {exporting ? "Exportando…" : "Exportar CSV"}
          </button>
        </div>
      </div>
      {!valid && <p className="field-error">La fecha «Hasta» tiene que ser igual o posterior a «Desde».</p>}
      {tooLong && <p className="field-error">El período puede ser de a lo sumo 366 días.</p>}

      <Outlet context={{ range, valid: valid && !tooLong } satisfies ReportsOutletContext} />
    </div>
  );
}
