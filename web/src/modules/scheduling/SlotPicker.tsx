import { useEffect } from "react";
import { errorMessage } from "../../lib/api";
import { formatTime } from "./format";
import { useAvailability, type AvailabilityParams, type Slot } from "./schedulingApi";

interface Props {
  params: AvailabilityParams | null;
  timeZone: string;
  value: string | null;
  onChange: (slot: Slot | null) => void;
  /** Si llega y está libre, se elige solo (p. ej. el horario donde se hizo clic en la agenda). */
  preferredStart?: string | null;
  /** Texto cuando todavía faltan datos para buscar. */
  idleHint?: string;
  label?: string;
}

/**
 * Horarios libres de `/availability` como un grupo de opciones (radio). Si el horario
 * elegido deja de estar entre los libres (otro lo tomó y se refrescó), se deselecciona.
 */
export default function SlotPicker({ params, timeZone, value, onChange, preferredStart, idleHint, label = "Horarios disponibles" }: Props) {
  const query = useAvailability(params);
  const slots = query.data?.slots ?? [];

  useEffect(() => {
    if (!query.data) return;
    if (value && !slots.some((s) => s.startsAt === value)) onChange(null);
    if (!value && preferredStart) {
      const match = slots.find((s) => s.startsAt === preferredStart);
      if (match) onChange(match);
    }
  }, [query.data]);

  if (!params || params.serviceIds.length === 0) return <p className="muted slot-hint">{idleHint ?? "Elegí los servicios para ver los horarios."}</p>;
  if (query.isPending) {
    return (
      <p className="muted slot-hint" role="status">
        Buscando horarios…
      </p>
    );
  }
  if (query.isError) return <p className="field-error">{errorMessage(query.error, "No pudimos cargar los horarios.")}</p>;
  if (slots.length === 0) return <p className="muted slot-hint">No hay horarios libres ese día. Probá con otra fecha u otro profesional.</p>;

  return (
    <div className="slot-grid" role="radiogroup" aria-label={label}>
      {slots.map((slot) => {
        const checked = slot.startsAt === value;
        return (
          <button
            key={slot.startsAt}
            type="button"
            role="radio"
            aria-checked={checked}
            className={"slot" + (checked ? " slot-selected" : "")}
            onClick={() => onChange(checked ? null : slot)}
          >
            {formatTime(slot.startsAt, timeZone)}
          </button>
        );
      })}
    </div>
  );
}
