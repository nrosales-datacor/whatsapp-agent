import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatInt } from "./format";

// ─────────────────────────────────────────────────────────────────────────────
// Gráfico de barras por día (SVG propio, sin librerías): conversaciones como barra de
// contexto (neutra) y, adentro, las citas que agendó el agente (acento del negocio). Un
// solo eje (las dos son cantidades). Leyenda siempre visible, tooltip al pasar el mouse o
// con las flechas del teclado, y la tabla con los mismos datos para quien no ve el gráfico.
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyPoint {
  date: string;
  conversations: number;
  bookings: number;
}

interface Props {
  data: DailyPoint[];
  /** Nombre accesible del gráfico (resume el rango y los totales). */
  label: string;
  /** Cómo llama el negocio a las citas (singular y plural, en minúscula). */
  appointment: string;
  appointments: string;
}

/** Singular o plural según la cantidad. */
const word = (n: number, one: string, many: string) => (n === 1 ? one : many);

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 34 };

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => value / s <= 4) ?? 10 * magnitude;
  return Math.ceil(value / step) * step;
}

/** Barra con las esquinas de arriba redondeadas (el dato termina arriba; la base queda recta). */
function barPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return "";
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function dayLabel(date: string, long: boolean): string {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d));
  return long
    ? value.toLocaleDateString("es-CR", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "")
    : value.toLocaleDateString("es-CR", { weekday: "short", day: "numeric", timeZone: "UTC" }).replace(".", "");
}

function fullDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export default function DailyChart({ data, label, appointment, appointments }: Props) {
  const legendBookings = `${appointments.charAt(0).toLocaleUpperCase("es")}${appointments.slice(1)} agendadas por el agente`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();

  // Ancho real del contenedor: el SVG se dibuja a escala 1:1 (el texto no se deforma).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = data.length;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(1, ...data.map((d) => Math.max(d.conversations, d.bookings))));
  const band = n > 0 ? plotW / n : plotW;
  const outer = Math.max(2, Math.min(28, band * 0.72));
  const inner = Math.max(2, outer * 0.55);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
  const longLabels = n > 14;
  const current = active !== null ? data[active] : null;

  function indexAt(clientX: number, target: SVGSVGElement): number {
    const rect = target.getBoundingClientRect();
    const x = clientX - rect.left - PAD.left;
    return Math.min(n - 1, Math.max(0, Math.floor(x / band)));
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (n > 0) setActive(indexAt(e.clientX, e.currentTarget));
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (n === 0) return;
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -n, End: n };
    if (!(e.key in keys)) return;
    e.preventDefault();
    setActive((prev) => Math.min(n - 1, Math.max(0, (prev ?? (keys[e.key] > 0 ? -1 : n)) + keys[e.key])));
  }

  const tooltipLeft = active !== null ? Math.min(width - 170, Math.max(0, PAD.left + band * active + band / 2 - 80)) : 0;

  return (
    <div className="wa-chart">
      <ul className="wa-chart-legend" aria-label="Leyenda">
        <li>
          <span className="wa-legend-key wa-legend-conversations" aria-hidden="true" />
          Conversaciones
        </li>
        <li>
          <span className="wa-legend-key wa-legend-bookings" aria-hidden="true" />
          {legendBookings}
        </li>
      </ul>
      <div className="wa-chart-frame" ref={containerRef}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={label}
          aria-describedby={current ? tooltipId : undefined}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="wa-chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="wa-chart-axis" x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">
                {formatInt(tick)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.left + band * i + band / 2;
            return (
              <g key={d.date} className={active === i ? "wa-chart-day active" : "wa-chart-day"}>
                {active === i && <rect className="wa-chart-hover" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} />}
                <path className="wa-chart-conversations" d={barPath(cx - outer / 2, y(d.conversations), outer, PAD.top + plotH - y(d.conversations))} />
                <path className="wa-chart-bookings" d={barPath(cx - inner / 2, y(d.bookings), inner, PAD.top + plotH - y(d.bookings))} />
                {i % labelEvery === 0 && (
                  <text className="wa-chart-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                    {dayLabel(d.date, longLabels)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="wa-chart-baseline" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
        </svg>
        <div id={tooltipId} className="wa-chart-tooltip" role="status" aria-live="polite" hidden={!current} style={{ left: tooltipLeft }}>
          {current && (
            <>
              <p className="wa-tooltip-day">{fullDayLabel(current.date)}</p>
              <p>
                <span className="wa-tooltip-key wa-legend-conversations" aria-hidden="true" />
                <strong className="tnum">{formatInt(current.conversations)}</strong> {word(current.conversations, "conversación", "conversaciones")}
              </p>
              <p>
                <span className="wa-tooltip-key wa-legend-bookings" aria-hidden="true" />
                <strong className="tnum">{formatInt(current.bookings)}</strong> {word(current.bookings, appointment, appointments)}
              </p>
            </>
          )}
        </div>
      </div>
      <details className="wa-chart-table">
        <summary>Ver los datos en una tabla</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Día</th>
              <th scope="col">Conversaciones</th>
              <th scope="col">{legendBookings}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <th scope="row">{fullDayLabel(d.date)}</th>
                <td className="tnum">{formatInt(d.conversations)}</td>
                <td className="tnum">{formatInt(d.bookings)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
