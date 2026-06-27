import { useQuery } from "@tanstack/react-query";
import { obtenerMetricas } from "../api";
import { colones } from "../lib/formato";

interface ItemBarra {
  et: string;
  v: number;
}

// Barras horizontales normalizadas al máximo del grupo (como renderBarras del inbox.html).
function Barras({ items }: { items: ItemBarra[] }) {
  if (!items.length) return <div style={{ color: "var(--gris)", fontSize: 13 }}>Sin datos todavía.</div>;
  const max = Math.max(1, ...items.map((i) => i.v));
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

// Dashboard de métricas (overlay a pantalla completa).
export default function Dashboard({ nombre, onCerrar }: { nombre: string; onCerrar: () => void }) {
  const q = useQuery({ queryKey: ["metricas"], queryFn: obtenerMetricas });
  const m = q.data;

  return (
    <div id="dashboard" className="activo">
      <div className="dash-head">
        <h2 id="dashTitulo">Panel · {nombre}</h2>
        <button type="button" onClick={onCerrar}>
          Volver a chats
        </button>
      </div>
      <div className="dash-body">
        <div className="kpis">
          <div className="kpi">
            <div className="n">{m?.totalConversaciones ?? 0}</div>
            <div className="l">Conversaciones</div>
          </div>
          <div className="kpi">
            <div className="n">{m?.totalCitas ?? 0}</div>
            <div className="l">Citas agendadas</div>
          </div>
          <div className="kpi">
            <div className="n">{(m?.conversionPct ?? 0) + "%"}</div>
            <div className="l">Conversión (chats → citas)</div>
          </div>
          <div className="kpi hero">
            <div className="n">{colones(m?.ingresosEstimados ?? 0)}</div>
            <div className="l">Ingresos estimados</div>
          </div>
        </div>
        <div className="card">
          <h3>Citas por día</h3>
          <Barras items={(m?.citasPorDia ?? []).map((d) => ({ et: d.fecha, v: d.cantidad }))} />
        </div>
        <div className="card">
          <h3>Servicios más pedidos</h3>
          <Barras items={(m?.serviciosTop ?? []).map((s) => ({ et: s.nombre || s.servicioId, v: s.cantidad }))} />
        </div>
        <div className="card">
          <h3>Horas pico</h3>
          <Barras items={(m?.horasPico ?? []).map((h) => ({ et: h.hora, v: h.cantidad }))} />
        </div>
      </div>
    </div>
  );
}
