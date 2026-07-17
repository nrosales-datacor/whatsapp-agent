import { useQuery } from "@tanstack/react-query";
import { obtenerMetricas, type Metricas } from "../api";
import { colones } from "../lib/formato";
import ErrorState from "./ErrorState";
import Icono, { type IconoId } from "./Iconos";

// ── KPI card ──────────────────────────────────────────────────────────────────

type Tono = "accent" | "neutro" | "success" | "danger";

interface KPIProps {
  icono: IconoId;
  label: string;
  valor: string;
  delta?: string;
  /** Dirección semántica del delta: "bueno" = verde, "malo" = rojo. Por defecto "bueno". */
  deltaTono?: "bueno" | "malo";
  tono?: Tono;
  /** Tarjeta más chica (grupos Actividad/Riesgo, 2 por fila) vs. la de Dinero (3 por fila). */
  compacta?: boolean;
}

/** Verde si sube (o el delta no trae signo, ej. "+∞"), rojo si baja. */
function deltaTonoDeSigno(delta?: string): "bueno" | "malo" {
  return delta?.startsWith("-") ? "malo" : "bueno";
}

function KPICard({ icono, label, valor, delta, deltaTono = "bueno", tono = "accent", compacta }: KPIProps) {
  return (
    <div className={"kpi" + (compacta ? " kpi-compacta" : "")}>
      <div className="kpi-top">
        <div className={`kpi-icon-badge tono-${tono}`}>
          <Icono id={icono} size={compacta ? 15 : 20} />
        </div>
        {!compacta && delta && <span className={"kpi-delta " + deltaTono}>{delta}</span>}
      </div>
      <div className="kpi-n">{valor}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

// ── Separador de grupo (eyebrow + línea) ──────────────────────────────────────

function GrupoTitulo({ children }: { children: string }) {
  return (
    <div className="dash-grupo">
      <span className="dash-grupo-titulo">{children}</span>
      <span className="dash-grupo-linea" />
    </div>
  );
}

// ── Hero "Plata rescatada por el bot" ─────────────────────────────────────────

function HeroRescate({ m }: { m: Metricas }) {
  return (
    <div className="hero-rescate">
      <div className="hero-eyebrow">
        <Icono id="shield" size={15} sw={2} />
        Plata rescatada por el bot
      </div>
      <div className="hero-monto tnum">{colones(m.rescateMontoRecuperado)}</div>
      {m.rescateRecuperados > 0 ? (
        <p className="hero-texto">
          El bot recuperó <b>{m.rescateRecuperados}</b>{" "}
          {m.rescateRecuperados === 1 ? "cotización que se iba a perder" : "cotizaciones que se iban a perder"} y las
          convirtió en citas — sin que intervinieras.
        </p>
      ) : (
        <p className="hero-texto">
          Activá el rescate de cotizaciones abandonadas en "Mi negocio" para que el bot recupere clientes que se iban
          a perder.
        </p>
      )}
      <div className="hero-submetricas">
        <div>
          <div className="hero-sub-v tnum">{m.rescateTasaPct != null ? m.rescateTasaPct + "%" : "—"}</div>
          <div className="hero-sub-l">Tasa de rescate</div>
        </div>
        <span className="hero-sep" />
        <div>
          <div className="hero-sub-v tnum">{m.ahorroBotPct}%</div>
          <div className="hero-sub-l">Sin intervención humana</div>
        </div>
      </div>
    </div>
  );
}

// ── Barras verticales (citas por día) ─────────────────────────────────────────

function BarrasVerticales({ items }: { items: { et: string; v: number }[] }) {
  if (!items.length) return <p className="dash-vacio">Sin datos todavía.</p>;
  const max = Math.max(1, ...items.map(i => i.v));
  return (
    <div className="citas-dia-wrap">
      {items.map((i, idx) => (
        <div className="cd-col" key={idx}>
          <span className="cd-num tnum">{i.v}</span>
          <div
            className={"cd-bar" + (idx === items.length - 1 ? " ultimo" : "")}
            style={{ height: Math.max(4, Math.round((i.v / max) * 110)) + "px" }}
          />
          <span className="cd-label tnum">{i.et}</span>
        </div>
      ))}
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

// ── Reputación en Google (Carril D, 1.3-c) ───────────────────────────────────

function Reputacion({
  rating,
  totalResenas,
  historico,
}: {
  rating: number;
  totalResenas: number;
  historico: { fecha: string; rating: number; totalResenas: number }[];
}) {
  return (
    <>
      <div className="reputacion-resumen">
        <Icono id="star" size={22} sw={0} />
        <span className="reputacion-rating">{rating.toFixed(1)}</span>
        <span className="reputacion-total">{totalResenas} reseñas en Google</span>
      </div>
      {historico.length >= 2 ? (
        <Barras items={historico.map((h) => ({ et: h.fecha.slice(5), v: h.rating }))} />
      ) : (
        <p className="dash-vacio">Necesitamos al menos 2 días de datos para graficar la evolución.</p>
      )}
    </>
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

  const dinero: KPIProps[] = [
    {
      icono: "money", label: "Ingresos estimados",
      valor: colones(m?.ingresosEstimados ?? 0),
      delta: m?.deltas?.ingresos, deltaTono: deltaTonoDeSigno(m?.deltas?.ingresos),
    },
    {
      icono: "money", label: "Ticket promedio",
      valor: colones(m?.ticketPromedio ?? 0),
    },
    {
      icono: "money", label: "Extra por add-ons (upsell)",
      valor: colones(m?.upsellMontoExtra ?? 0),
    },
  ];

  const actividad: KPIProps[] = [
    {
      icono: "chat", label: "Conversaciones", tono: "neutro", compacta: true,
      valor: String(m?.totalConversaciones ?? 0), delta: m?.deltas?.conversaciones,
    },
    {
      icono: "cal", label: "Citas agendadas", tono: "neutro", compacta: true,
      valor: String(m?.totalCitas ?? 0), delta: m?.deltas?.citas,
    },
    {
      icono: "trend", label: "Conversión", tono: "neutro", compacta: true,
      valor: (m?.conversionPct ?? 0) + "%", delta: m?.deltas?.conversion,
    },
    {
      icono: "bot", label: "Ahorro del bot (sin humano)", tono: "neutro", compacta: true,
      valor: (m?.ahorroBotPct ?? 0) + "%",
    },
  ];

  const riesgo: KPIProps[] = [
    {
      icono: "alert", label: "Tasa de no-show", tono: "danger", compacta: true,
      valor: m?.noShowPct != null ? m.noShowPct + "%" : "—",
    },
    {
      icono: "trend", label: "Tasa de rescate", tono: "success", compacta: true,
      valor: m?.rescateTasaPct != null ? m.rescateTasaPct + "%" : "—",
    },
    {
      icono: "trend", label: "Aceptación de upsell", tono: "success", compacta: true,
      valor: m?.upsellTasaPct != null ? m.upsellTasaPct + "%" : "—",
    },
    {
      icono: "star", label: "Reseñas solicitadas", tono: "neutro", compacta: true,
      valor: String(m?.resenasSolicitadas ?? 0),
    },
  ];

  return (
    <div id="dashboard">
      <div className="dash-body">
        <div className="dash-titulo">
          <h2>Panel · {nombre}</h2>
          <p>Resumen de los últimos 7 días</p>
        </div>

        {m && <HeroRescate m={m} />}

        <GrupoTitulo>Dinero</GrupoTitulo>
        <div className="kpis">
          {dinero.map((k, i) => <KPICard key={i} {...k} />)}
        </div>

        <GrupoTitulo>Actividad del bot</GrupoTitulo>
        <div className="kpis-sec">
          {actividad.map((k, i) => <KPICard key={i} {...k} />)}
        </div>

        <GrupoTitulo>Riesgo y calidad</GrupoTitulo>
        <div className="kpis-sec">
          {riesgo.map((k, i) => <KPICard key={i} {...k} />)}
        </div>

        <div className="card">
          <h3>Citas por día</h3>
          <BarrasVerticales items={(m?.citasPorDia ?? []).map(d => ({ et: d.fecha, v: d.cantidad }))} />
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

        {m?.reputacion && (
          <div className="card">
            <h3>Reputación en Google</h3>
            <Reputacion {...m.reputacion} />
          </div>
        )}

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
