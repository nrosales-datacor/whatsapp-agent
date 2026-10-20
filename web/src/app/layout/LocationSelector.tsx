import { useId } from "react";
import Icon from "../../ui/Icons";
import { ALL_LOCATIONS, useActiveLocation } from "../location";
import { capitalize, terminologyOf } from "../navigation";
import { useSession } from "../session";

/**
 * Selector de sucursal del encabezado. Un <select> nativo (teclado y lectores de pantalla
 * gratis). Con una sola opción posible se muestra fijo, sin desplegable.
 */
export default function LocationSelector() {
  const me = useSession();
  const t = terminologyOf(me);
  const { locations, canSelectAll, selected, label, allLabel, select } = useActiveLocation();
  const id = useId();
  const optionCount = locations.length + (canSelectAll ? 1 : 0);

  if (optionCount <= 1) {
    return (
      <div className="location-static" title={`${capitalize(t.location)}: ${label}`}>
        <Icon id="mapPin" size={16} />
        <span className="visually-hidden">{capitalize(t.location)}: </span>
        <span className="location-name">{label}</span>
      </div>
    );
  }

  return (
    <div className="location-select">
      <label htmlFor={id} className="visually-hidden">
        {capitalize(t.location)}
      </label>
      <Icon id="mapPin" size={16} />
      <select id={id} value={selected} onChange={(e) => select(e.target.value)}>
        {canSelectAll && <option value={ALL_LOCATIONS}>{allLabel}</option>}
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <Icon id="chevronDown" size={16} />
    </div>
  );
}
