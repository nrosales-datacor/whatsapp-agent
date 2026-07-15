import { useQuery } from "@tanstack/react-query";
import { obtenerMetricas } from "../api";
import { colones } from "../lib/formato";
import ErrorState from "./ErrorState";
import Icono, { type IconoId } from "./Iconos";

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KPIProps {
  icono: IconoId;
  label: string;
  valor: string;
  delta?: string;
  hero?: boolean;
}

function KPICard({ icono, label, valor, delta, hero }: KPIProps) {
  return (
    <div className={"kpi" + (hero ? " hero" : "")}>
      <div className="kpi-top">
        <div className="kpi-icon-badge">
          <Icono id={icono} size={20} />
        </div>
        {delta && <span className="kpi-delta">{delta}</span>}
      </div>
      <div className="kpi-n">{valor}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

// ── Barras horizontales (citas por día) ───────────────────────────────────────

function Barras({ items }: { items: { et: string; v: number }[] }) {
  if (!items.length) return <p className="dash-vacio">Sin datos todavía.</p>;
  const max = Math.max(1, ...items.map(i => i.v));
  return (
    <>
      {items.map((i, idx) => (
        <div className="barra" key={idx}>
          <span className="et">{i.et}</span>
          <span className="track">
            <span className="fill" style={{ width: Math.round((i.v / max) * 100) + "%" }} />
          </span>
          <span className="v">{i.v}</span>
        </div>
      ))}
    </>
  );
}

// ── Ranking de servicios ──────────────────────────────────────────────────────

interface ServicioItem { servicioId: string; nombre?: string; cantidad: number }

function ServiciosRanking({ items }: { items: ServicioItem[] }) {
  if (!items.length) return <p className="dash-vacio">Sin datos todavía.</p>;
  const max = Math.max(1, ...items.map(i => i.cantidad));
  return (
    <>
      {items.map((s, i) => (
        <div className="ranking-row" key={i}>
          <span className="rank-num">{i + 1}</span>
          <div className="rank-info">
            <div className="rank-nombre">{s.nombre || s.servicioId}</div>
            <div className="rank-track">
              <div className="rank-fill" style={{ width: Math.round((s.cantidad / max) * 100) + "%" }} />
            </div>
          </div>
          <span className="rank-v">{s.cantidad}</span>
        </div>
      ))}
    </>
  );
}

// ── Split de dos valores (citas bot/manual, clientes nuevos/recurrentes) ─────

interface SplitItem { label: string; valor: number }

function SplitBar({ items }: { items: [SplitItem, SplitItem] }) {
  const total = items[0].valor + items[1].valor;
  if (!total) return <p className="dash-vacio">Sin datos todavía.</p>;
  return (
    <div>
      <div className="split-track">
        {items.map((it, i) => (
          <span
            key={i}
            className={"split-seg split-seg-" + i}
            style={{ width: Math.round((it.valor / total) * 100) + "%" }}
          />
        ))}
      </div>
      <div className="split-leyenda">
        {items.map((it, i) => (
          <span key={i} className={"split-item split-item-" + i}>
            <b>{it.valor}</b> {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Horas pico (barras verticales) ───────────────────────────────────────────

const BAR_MAX_H = 96; // px de altura máxima para la barra más alta

function HorasPico({ items }: { items: { hora: string; cantidad: number }[] }) {
  if (!items.length) return <p className="dash-vacio">Sin datos todavía.</p>;
  const max = Math.max(1, ...items.map(i => i.cantidad));
  return (
    <div className="horas-pico-wrap">
      <div className="horas-pico-grid">
        {items.map((h, i) => {
          const barH = Math.max(4, Math.round((h.cantidad / max) * BAR_MAX_H));
          return (
            <div key={i} className="bv-col">
              <span className="bv-num">{h.cantidad}</span>
              <div className="bv-bar" style={{ height: barH }} />
              <span className="bv-label">{h.hora}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard({ nombre }: { nombre: string }) {
  const q = useQuery({ queryKey: ["metricas"], queryFn: obtenerMetricas });
  const m = q.data;

  if (q.isError) {
    return (
      <div id="dashboard">
        <div className="dash-body">
          <ErrorState mensaje="No se pudieron cargar las métricas." onReintentar={() => q.refetch()} />
        </div>
      </div>
    );
  }

  const kpis: KPIProps[] = [
    {
      icono: "chat", label: "Conversaciones",
      valor: String(m?.totalConversaciones ?? 0),
      delta: m?.deltas?.conversaciones,
    },
    {
      icono: "cal", label: "Citas agendadas",
      valor: String(m?.totalCitas ?? 0),
      delta: m?.deltas?.citas,
    },
    {
      icono: "trend", label: "Conversión",
      valor: (m?.conversionPct ?? 0) + "%",
      delta: m?.deltas?.conversion,
    },
    {
      icono: "money", label: "Ingresos estimados",
      valor: colones(m?.ingresosEstimados ?? 0),
      delta: m?.deltas?.ingresos,
      hero: true,
    },
    {
      icono: "bot", label: "Ahorro del bot (sin humano)",
      valor: (m?.ahorroBotPct ?? 0) + "%",
      hero: true,
    },
    {
      icono: "alert", label: "Tasa de no-show",
      valor: m?.noShowPct != null ? m.noShowPct + "%" : "—",
    },
  ];

  return (
    <div id="dashboard">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Panel · {nombre}</h2>
        </div>

        <div className="kpis">
          {kpis.map((k, i) => <KPICard key={i} {...k} />)}
        </div>

        <div className="card">
          <h3>Citas por día</h3>
          <Barras items={(m?.citasPorDia ?? []).map(d => ({ et: d.fecha, v: d.cantidad }))} />
        </div>

        <div className="dash-grid-2">
          <div className="card">
            <h3>Servicios más pedidos</h3>
            <ServiciosRanking items={m?.serviciosTop ?? []} />
          </div>
          <div className="card">
            <h3>Horas pico</h3>
            <HorasPico items={m?.horasPico ?? []} />
          </div>
        </div>

        <div className="dash-grid-2">
          <div className="card">
            <h3>Origen de las citas</h3>
            <SplitBar
              items={[
                { label: "por el bot", valor: m?.citasBot ?? 0 },
                { label: "manuales", valor: m?.citasManuales ?? 0 },
              ]}
            />
          </div>
          <div className="card">
            <h3>Clientes nuevos vs. recurrentes</h3>
            <SplitBar
              items={[
                { label: "nuevos", valor: m?.clientesNuevos ?? 0 },
                { label: "recurrentes", valor: m?.clientesRecurrentes ?? 0 },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
