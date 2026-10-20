import Icon from "./Icons";

interface Props {
  message: string;
  error?: boolean;
  onRetry?: () => void;
}

/** Pantalla completa de "cargando" o de error antes de tener la sesión. */
export default function FullPageStatus({ message, error, onRetry }: Props) {
  return (
    <div className="full-page-status" role={error ? "alert" : "status"}>
      {error ? (
        <div className="empty-state-icon empty-state-icon-danger">
          <Icon id="cloudOff" size={26} strokeWidth={1.6} />
        </div>
      ) : (
        <span className="spinner" aria-hidden="true" />
      )}
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <Icon id="refresh" size={16} />
          Reintentar
        </button>
      )}
    </div>
  );
}
