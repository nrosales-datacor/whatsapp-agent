import Icono, { type IconoId } from "./Iconos";

interface Props {
  icono: IconoId;
  titulo: string;
  ayuda?: string;
  accion?: { texto: string; onClick: () => void; icono?: IconoId };
}

/** Estado vacío enriquecido (ícono en chip + título + ayuda + CTA), ver design_handoff_panel_whatsapp/. */
export default function EstadoVacio({ icono, titulo, ayuda, accion }: Props) {
  return (
    <div className="estado-vacio">
      <div className="estado-vacio-icono">
        <Icono id={icono} size={26} sw={1.6} />
      </div>
      <p className="estado-vacio-titulo">{titulo}</p>
      {ayuda && <p className="estado-vacio-ayuda">{ayuda}</p>}
      {accion && (
        <button type="button" className="accion accion-outline" onClick={accion.onClick}>
          {accion.icono && <Icono id={accion.icono} size={14} />}
          {accion.texto}
        </button>
      )}
    </div>
  );
}
