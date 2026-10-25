import { useState } from "react";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import ErrorState from "../../ui/ErrorState";
import Icon, { type IconId } from "../../ui/Icons";
import { todayIn } from "../scheduling/format";
import DailyChart from "./DailyChart";
import { addDays, formatAiCost, formatInt, formatPercent } from "./format";
import { useWhatsappMetrics } from "./whatsappApi";
import { AGENT_MANAGERS } from "./WhatsappLayout";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

function rangeLabel(from: string, to: string): string {
  const fmt = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { day: "numeric", month: "long", timeZone: "UTC" });
  };
  return `del ${fmt(from)} al ${fmt(to)}`;
}

/** Métricas del agente (/whatsapp/metrics): KPIs del rango y el gráfico por día. */
export default function MetricsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const [range, setRange] = useState<Range>(30);
  const to = todayIn(me.business.timezone);
  const from = addDays(to, -(range - 1));
  const query = useWhatsappMetrics(from, to);
  const m = query.data;
  const showCost = AGENT_MANAGERS.includes(me.role);
  const growthFeatures = ["reviews", "quote_recovery"].filter((f) => me.plan.features.includes(f));

  return (
    <div className="wa-metrics">
      <div className="wa-range" role="group" aria-label="Período">
        {RANGES.map((days) => (
          <button key={days} type="button" className={"wa-filter" + (range === days ? " active" : "")} aria-pressed={range === days} onClick={() => setRange(days)}>
            {days} días
          </button>
        ))}
        <span className="muted wa-range-label">{capitalize(rangeLabel(from, to))}</span>
      </div>

      {query.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando las métricas…</span>
        </div>
      ) : query.isError || !m ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar las métricas del agente.")} onRetry={() => void query.refetch()} />
      ) : (
        <div className={"wa-metrics-body" + (query.isPlaceholderData ? " refreshing" : "")} aria-busy={query.isPlaceholderData}>
          <ul className="wa-kpis">
            <Kpi icon="chat" label="Conversaciones" value={formatInt(m.conversations)} />
            <Kpi
              icon="bot"
              label="Resueltas sin una persona"
              value={formatInt(m.resolvedWithoutHuman)}
              note={`${formatPercent(m.resolvedWithoutHuman, m.conversations)} de las conversaciones`}
            />
            <Kpi
              icon="calendar"
              label={`${capitalize(t.appointments)} agendadas por el agente`}
              value={formatInt(m.bookingsByAgent)}
              note={`${formatPercent(m.bookingsByAgent, m.conversations)} de las conversaciones`}
            />
            <Kpi icon="hand" label="Pasadas a una persona" value={formatInt(m.handoffs)} note={`${formatPercent(m.handoffs, m.conversations)} de las conversaciones`} />
            {showCost && (
              <Kpi
                icon="sparkles"
                label="Costo de la IA"
                value={formatAiCost(m.aiCostMicros)}
                note={m.conversations ? `${formatAiCost(m.aiCostMicros / m.conversations)} por conversación` : undefined}
              />
            )}
          </ul>

          <section className="card wa-chart-card" aria-labelledby="wa-chart-title">
            <h2 id="wa-chart-title" className="card-title">
              Por día
            </h2>
            {m.byDay.length === 0 ? (
              <p className="muted">No hay datos en este período.</p>
            ) : (
              <DailyChart
                data={m.byDay}
                appointment={t.appointment}
                appointments={t.appointments}
                label={`Conversaciones y ${t.appointments} agendadas por el agente por día, ${rangeLabel(from, to)}: ${formatInt(m.conversations)} conversaciones y ${formatInt(m.bookingsByAgent)} ${t.appointments}.`}
              />
            )}
          </section>

          {growthFeatures.length > 0 && (
            <section className="wa-growth-metrics" aria-labelledby="wa-growth-title">
              <h2 id="wa-growth-title" className="card-title">
                Crecimiento
              </h2>
              <ul className="wa-kpis">
                {growthFeatures.includes("reviews") && (
                  <>
                    <Kpi
                      icon="star"
                      label="Seguimientos post-servicio"
                      value={formatInt(m.growth.followUps.sent)}
                      note={`${formatInt(m.growth.followUps.answered)} respondieron · ${formatInt(m.growth.followUps.negative)} con una mala experiencia`}
                    />
                    <Kpi
                      icon="sparkles"
                      label="Reseñas pedidas"
                      value={formatInt(m.growth.followUps.reviewsRequested)}
                      note={`${formatPercent(m.growth.followUps.positive, m.growth.followUps.answered)} respondió «Excelente»`}
                    />
                  </>
                )}
                {growthFeatures.includes("quote_recovery") && (
                  <>
                    <Kpi
                      icon="receipt"
                      label="Cotizaciones sin agendar"
                      value={formatInt(m.growth.quotes.created)}
                      note={`${formatInt(m.growth.quotes.touched)} recibieron un recordatorio`}
                    />
                    <Kpi
                      icon="refresh"
                      label="Cotizaciones recuperadas"
                      value={formatInt(m.growth.quotes.recovered)}
                      note={`${formatCents(m.growth.quotes.recoveredCents, me.business.currency)} agendados después del rescate`}
                    />
                  </>
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, note }: { icon: IconId; label: string; value: string; note?: string }) {
  return (
    <li className="card wa-kpi">
      <span className="wa-kpi-icon" aria-hidden="true">
        <Icon id={icon} size={18} />
      </span>
      <span className="wa-kpi-label">{label}</span>
      <span className="wa-kpi-value tnum">{value}</span>
      {note && <span className="wa-kpi-note muted">{note}</span>}
    </li>
  );
}
