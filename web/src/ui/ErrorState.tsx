import Icon from "./Icons";

interface Props {
  message: string;
  onRetry?: () => void;
}

// Reasegura que el fallo es de carga, no de datos: mismo texto en todos los usos.
const HELP = "Tus datos están a salvo, esto fue solo un problema para cargarlos.";

/** Estado de error de carga: chip de ícono + título + ayuda + Reintentar. */
export default function ErrorState({ message, onRetry }: Props) {
  return (
    <div className="empty-state" role="alert">
      <div className="empty-state-icon empty-state-icon-danger">
        <Icon id="cloudOff" size={26} strokeWidth={1.6} />
      </div>
      <p className="empty-state-title">{message}</p>
      <p className="empty-state-help">{HELP}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <Icon id="refresh" size={16} />
          Reintentar
        </button>
      )}
    </div>
  );
}
