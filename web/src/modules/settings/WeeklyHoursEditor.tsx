import { useId } from "react";
import Icon from "../../ui/Icons";
import { blockKey, DISPLAY_WEEKDAYS, MAX_BLOCKS_PER_DAY, WEEKDAY_NAMES, type HoursDraft } from "./hoursDraft";

// ─────────────────────────────────────────────────────────────────────────────
// Editor del horario semanal (sucursales y profesionales): un grupo por día con casilla
// "abierto", sus tramos (inicio y fin) y "Agregar tramo" para los descansos. Controlado:
// el borrador y los errores (clave `día.tramo`, ver ./hoursDraft.ts) los maneja quien lo
// usa. Inputs nativos de hora: teclado y lector de pantalla sin trabajo extra.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  value: HoursDraft;
  onChange: (next: HoursDraft) => void;
  errors?: Record<string, string>;
  /** Texto de la casilla ("Abierto" para una sucursal, "Trabaja" para un profesional). */
  openLabel?: string;
  /** Texto de un día sin tramos. */
  closedLabel?: string;
  disabled?: boolean;
}

const DEFAULT_BLOCK = { start: "09:00", end: "18:00" };

export default function WeeklyHoursEditor({ value, onChange, errors = {}, openLabel = "Abierto", closedLabel = "Cerrado", disabled }: Props) {
  const baseId = useId();

  function setDay(weekday: number, blocks: HoursDraft[number]) {
    onChange(value.map((day, i) => (i === weekday ? blocks : day)));
  }

  function copyMondayToWeekdays() {
    const monday = value[1];
    onChange(value.map((day, i) => (i >= 2 && i <= 5 ? monday.map((b) => ({ ...b })) : day)));
  }

  return (
    <div className="hours-editor">
      <div className="settings-toolbar">
        <button type="button" className="btn btn-secondary btn-small" onClick={copyMondayToWeekdays} disabled={disabled || value[1].length === 0}>
          Copiar el lunes a martes–viernes
        </button>
      </div>
      {DISPLAY_WEEKDAYS.map((weekday) => {
        const day = value[weekday];
        const name = WEEKDAY_NAMES[weekday];
        const open = day.length > 0;
        const checkId = `${baseId}-${weekday}`;
        return (
          <fieldset key={weekday} className="hours-day">
            <legend className="visually-hidden">{name}</legend>
            <div className="hours-day-head">
              <span className="hours-day-name" aria-hidden="true">
                {name}
              </span>
              <label className="check-row" htmlFor={checkId}>
                <input
                  id={checkId}
                  type="checkbox"
                  checked={open}
                  disabled={disabled}
                  onChange={(e) => setDay(weekday, e.target.checked ? [{ ...DEFAULT_BLOCK }] : [])}
                />
                <span>
                  {openLabel}
                  <span className="visually-hidden"> el {name.toLowerCase()}</span>
                </span>
              </label>
            </div>
            {open ? (
              <div className="hours-blocks">
                {day.map((block, i) => {
                  const error = errors[blockKey(weekday, i)];
                  const errorId = `${checkId}-${i}-error`;
                  const n = i + 1;
                  return (
                    <div key={i} className="hours-block">
                      <input
                        type="time"
                        className="input"
                        value={block.start}
                        disabled={disabled}
                        aria-label={`${name}, inicio del tramo ${n}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        onChange={(e) => setDay(weekday, day.map((b, j) => (j === i ? { ...b, start: e.target.value } : b)))}
                      />
                      <span className="hours-block-sep" aria-hidden="true">
                        a
                      </span>
                      <input
                        type="time"
                        className="input"
                        value={block.end}
                        disabled={disabled}
                        aria-label={`${name}, fin del tramo ${n}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        onChange={(e) => setDay(weekday, day.map((b, j) => (j === i ? { ...b, end: e.target.value } : b)))}
                      />
                      <button
                        type="button"
                        className="icon-btn danger"
                        aria-label={`Quitar el tramo ${n} del ${name.toLowerCase()}`}
                        disabled={disabled}
                        onClick={() => setDay(weekday, day.filter((_, j) => j !== i))}
                      >
                        <Icon id="x" size={16} />
                      </button>
                      {error && (
                        <p id={errorId} className="field-error">
                          {error}
                        </p>
                      )}
                    </div>
                  );
                })}
                {day.length < MAX_BLOCKS_PER_DAY && (
                  <div>
                    <button
                      type="button"
                      className="link-button"
                      disabled={disabled}
                      onClick={() => {
                        const last = day[day.length - 1];
                        // El tramo nuevo arranca una hora después del anterior (típico: el almuerzo).
                        const startH = Math.min(23, Number(last.end.slice(0, 2) || "12") + 1);
                        const start = `${String(startH).padStart(2, "0")}:00`;
                        const end = `${String(Math.min(23, startH + 4)).padStart(2, "0")}:00`;
                        setDay(weekday, [...day, { start, end: end > start ? end : "00:00" }]);
                      }}
                    >
                      + Agregar tramo<span className="visually-hidden"> el {name.toLowerCase()}</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="hours-closed">{closedLabel}</p>
            )}
          </fieldset>
        );
      })}
      <p className="settings-help">Un fin a las 00:00 significa abierto hasta la medianoche. Los descansos son tramos separados el mismo día.</p>
    </div>
  );
}
