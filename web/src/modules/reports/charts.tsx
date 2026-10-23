import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Gráficos de Reportes e Inicio (SVG propio, sin librerías), con las reglas de la casa:
//   • un solo eje (nunca dos escalas); una serie = el acento del negocio; dos series
//     apiladas = el acento (lo que importa) sobre un neutro (el contexto), con leyenda;
//   • marcas finas con la punta redondeada y la base recta, 2 px de separación entre
//     segmentos apilados; grilla y ejes recesivos;
//   • tooltip al pasar el mouse o con las flechas del teclado (el SVG es enfocable), y
//     SIEMPRE la tabla con los mismos datos para quien no ve el gráfico;
//   • el texto usa los tonos de texto, nunca el color de la serie.
// Se dibuja a escala 1:1 con el ancho real del contenedor (el texto no se deforma).
// ─────────────────────────────────────────────────────────────────────────────

function useWidth(min = 240): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(min, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [min]);
  return [ref, width];
}

/** Tope "redondo" del eje (1, 2, 2,5, 5 × 10ⁿ) con a lo sumo 4 tramos. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => value / s <= 4) ?? 10 * magnitude;
  return Math.ceil(value / step) * step;
}

/** Barra con las esquinas de arriba redondeadas (el dato termina arriba; la base queda recta). */
function barUp(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0 || width <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** Barra horizontal con la punta derecha redondeada. */
function barRight(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0 || width <= 0) return "";
  const r = Math.min(radius, height / 2, width);
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
}

const shortDay = (date: string, long: boolean): string => {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d));
  return long
    ? value.toLocaleDateString("es-CR", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "")
    : value.toLocaleDateString("es-CR", { weekday: "short", day: "numeric", timeZone: "UTC" }).replace(".", "");
};

export const fullDay = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
};

// ── Barras por día ──────────────────────────────────────────────────────────

export interface DaySeries {
  name: string;
  /** "main" = el acento; "context" = el neutro (va abajo en el apilado). */
  tone: "main" | "context";
}

export interface DayPoint {
  date: string;
  /** Un valor por serie, en el orden de `series`. */
  values: number[];
}

interface DayBarChartProps {
  data: DayPoint[];
  series: DaySeries[];
  /** Nombre accesible (resume el rango y el total). */
  label: string;
  /** Formato de los valores (montos, cantidades). */
  format: (value: number) => string;
  /** Formato corto para el eje (default: `format`). */
  axisFormat?: (value: number) => string;
  height?: number;
  /** Texto del resumen de la tabla. */
  tableSummary?: string;
}

const PAD = { top: 12, right: 8, bottom: 26, left: 56 };

/** Barras verticales por día (una serie, o dos apiladas). */
export function DayBarChart({ data, series, label, format, axisFormat = format, height = 220, tableSummary = "Ver los datos en una tabla" }: DayBarChartProps) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  // Apilado: el contexto abajo, lo principal arriba.
  const order = series.map((s, i) => ({ ...s, i })).sort((a, b) => (a.tone === b.tone ? a.i - b.i : a.tone === "context" ? -1 : 1));
  const n = data.length;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const totals = data.map((d) => d.values.reduce((s, v) => s + Math.max(0, v), 0));
  const max = niceMax(Math.max(1, ...totals));
  const band = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(28, band * 0.7));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
  const longLabels = n > 14;
  const current = active !== null ? data[active] : null;

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - rect.left - PAD.left) / band))));
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (n === 0) return;
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -n, End: n };
    if (!(e.key in keys)) return;
    e.preventDefault();
    setActive((prev) => Math.min(n - 1, Math.max(0, (prev ?? (keys[e.key] > 0 ? -1 : n)) + keys[e.key])));
  }

  const tooltipLeft = active !== null ? Math.min(width - 190, Math.max(0, PAD.left + band * active + band / 2 - 90)) : 0;

  return (
    <div className="rp-chart">
      {series.length > 1 && (
        <ul className="rp-legend" aria-label="Leyenda">
          {series.map((s) => (
            <li key={s.name}>
              <span className={`rp-key rp-tone-${s.tone}`} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="rp-chart-frame" ref={ref}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
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
              <line className="rp-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="rp-axis" x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">
                {axisFormat(tick)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = PAD.left + band * i + band / 2 - barW / 2;
            let base = 0;
            const segments = order.map((s, k) => {
              const v = Math.max(0, d.values[s.i] ?? 0);
              const yBottom = y(base);
              const yTop = y(base + v);
              base += v;
              if (v <= 0) return null;
              // El de más arriba lleva la punta redondeada; los de abajo dejan 2 px de superficie.
              const isTop = order.slice(k + 1).every((o) => (d.values[o.i] ?? 0) <= 0);
              const path = isTop
                ? barUp(x, yTop, barW, yBottom - yTop)
                : `M${x},${Math.min(yTop + 2, yBottom)}h${barW}V${yBottom}h${-barW}Z`;
              return <path key={s.name} className={`rp-bar rp-tone-${s.tone}`} d={path} />;
            });
            return (
              <g key={d.date} className={active === i ? "rp-day active" : "rp-day"}>
                {active === i && <rect className="rp-hover" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} />}
                {segments}
                {i % labelEvery === 0 && (
                  <text className="rp-axis" x={x + barW / 2} y={height - 8} textAnchor="middle">
                    {shortDay(d.date, longLabels)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="rp-baseline" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
        </svg>
        <div id={tooltipId} className="rp-tooltip" role="status" aria-live="polite" hidden={!current} style={{ left: tooltipLeft }}>
          {current && (
            <>
              <p className="rp-tooltip-title">{fullDay(current.date)}</p>
              {series.map((s, i) => (
                <p key={s.name}>
                  {series.length > 1 && <span className={`rp-tooltip-key rp-tone-${s.tone}`} aria-hidden="true" />}
                  {series.length > 1 && <span>{s.name}: </span>}
                  <strong className="tnum">{format(current.values[i] ?? 0)}</strong>
                </p>
              ))}
            </>
          )}
        </div>
      </div>
      <details className="rp-table">
        <summary>{tableSummary}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Día</th>
              {series.map((s) => (
                <th scope="col" key={s.name}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <th scope="row">{fullDay(d.date)}</th>
                {series.map((s, i) => (
                  <td key={s.name} className="tnum">
                    {format(d.values[i] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ── Ranking (barras horizontales) ───────────────────────────────────────────

export interface RankingItem {
  key: string;
  label: string;
  value: number;
  /** Valor ya formateado para la etiqueta directa y la tabla. */
  display: string;
}

interface RankingChartProps {
  items: RankingItem[];
  /** Nombre accesible del gráfico. */
  label: string;
  /** Encabezados de la tabla equivalente. */
  labelHeader: string;
  valueHeader: string;
  /** Cuántos mostrar en el gráfico (la tabla los trae todos). Default 8. */
  limit?: number;
  /** Contenido extra de la tabla (p. ej. una nota). */
  footnote?: ReactNode;
}

const ROW = 30;
const BAR_H = 14;

/** Barras horizontales ordenadas (la etiqueta a la izquierda, el valor al final de la barra). */
export function RankingChart({ items, label, labelHeader, valueHeader, limit = 8, footnote }: RankingChartProps) {
  const [ref, width] = useWidth(220);
  const shown = items.slice(0, limit);
  const labelW = Math.min(180, Math.max(90, Math.floor(width * 0.34)));
  const valueW = 92;
  const plotW = Math.max(40, width - labelW - valueW - 12);
  const max = Math.max(1, ...shown.map((i) => i.value));
  const height = Math.max(ROW, shown.length * ROW);
  const truncate = (text: string) => {
    const chars = Math.max(6, Math.floor((labelW - 10) / 7));
    return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
  };

  return (
    <div className="rp-chart">
      <div className="rp-chart-frame" ref={ref}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
          {shown.map((item, i) => {
            const cy = i * ROW + ROW / 2;
            const w = item.value > 0 ? Math.max(3, (item.value / max) * plotW) : 0;
            return (
              <g key={item.key}>
                <title>{`${item.label}: ${item.display}`}</title>
                <text className="rp-rank-label" x={labelW - 8} y={cy} dy="0.32em" textAnchor="end">
                  {truncate(item.label)}
                </text>
                <rect className="rp-rank-track" x={labelW} y={cy - BAR_H / 2} width={plotW} height={BAR_H} rx={4} />
                {w > 0 && <path className="rp-bar rp-tone-main" d={barRight(labelW, cy - BAR_H / 2, w, BAR_H)} />}
                <text className="rp-rank-value tnum" x={labelW + w + 6} y={cy} dy="0.32em">
                  {item.display}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="rp-table">
        <summary>Ver los datos en una tabla</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{labelHeader}</th>
              <th scope="col">{valueHeader}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <th scope="row">{item.label}</th>
                <td className="tnum">{item.display}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {footnote}
      </details>
    </div>
  );
}

/** Medidor de una proporción (ocupación, retención): barra fina + el porcentaje en texto. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? null : Math.round(value * 1000) / 10;
  return (
    <span className="rp-meter" role="img" aria-label={pct === null ? `${label}: sin datos` : `${label}: ${pct.toLocaleString("es-CR")} %`}>
      <span className="rp-meter-track" aria-hidden="true">
        <span className="rp-meter-fill" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </span>
      <span className="rp-meter-text tnum" aria-hidden="true">
        {pct === null ? "—" : `${pct.toLocaleString("es-CR")} %`}
      </span>
    </span>
  );
}
