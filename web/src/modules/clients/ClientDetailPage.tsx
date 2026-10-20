import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import SectionPlaceholder from "../../app/SectionPlaceholder";
import Icon from "../../ui/Icons";

/** Ficha de un cliente (/clients/:id), enlazable desde una notificación. Llega en I1. */
export default function ClientDetailPage() {
  const me = useSession();
  const t = terminologyOf(me);
  return (
    <SectionPlaceholder
      id="clients"
      title={`Ficha del ${t.client}`}
      description={`Los datos del ${t.client}, su historial de ${t.appointments}, sus pagos y sus notas.`}
      planned={["Datos de contacto", `Historial de ${t.appointments}`, "Pagos", "Notas"]}
      icon="user"
      before={
        <Link to="/clients" className="back-link">
          <Icon id="chevronLeft" size={16} />
          Volver a {capitalize(t.clients)}
        </Link>
      }
    />
  );
}
