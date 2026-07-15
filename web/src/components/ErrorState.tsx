import Icono from "./Iconos";

interface Props {
  mensaje: string;
  onReintentar?: () => void;
}

/** Estado de error reutilizable (ícono + mensaje + Reintentar) para queries fallidas del panel. */
export default function ErrorState({ mensaje, onReintentar }: Props) {
  return (
    <div className="error-state">
      <Icono id="alert" size={28} sw={1.6} />
      <p>{mensaje}</p>
      {onReintentar && (
        <button type="button" className="accion accion-outline" onClick={onReintentar}>
          Reintentar
        </button>
      )}
    </div>
  );
}
