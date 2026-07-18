import Icono from "./Iconos";

interface Props {
  mensaje: string;
  onReintentar?: () => void;
}

// Reasegura que el fallo es de carga, no de datos — mismo texto en todos los usos,
// no hace falta que cada pantalla lo repita.
const AYUDA = "Tus datos están a salvo, esto fue solo un problema para cargarlos.";

/** Estado de error reutilizable (chip de ícono + título + ayuda + Reintentar), ver design_handoff_panel_whatsapp/. */
export default function ErrorState({ mensaje, onReintentar }: Props) {
  return (
    <div className="estado-vacio">
      <div className="estado-vacio-icono estado-vacio-icono-danger">
        <Icono id="cloudoff" size={26} sw={1.6} />
      </div>
      <p className="estado-vacio-titulo">{mensaje}</p>
      <p className="estado-vacio-ayuda">{AYUDA}</p>
      {onReintentar && (
        <button type="button" className="accion accion-outline" onClick={onReintentar}>
          <Icono id="refresh" size={14} />
          Reintentar
        </button>
      )}
    </div>
  );
}
