import { Link } from "react-router-dom";
import EmptyState from "../ui/EmptyState";
import PageHeader from "../ui/PageHeader";
import { homePathFor } from "./navigation";
import { useSession } from "./session";

/** Ruta desconocida dentro del panel. */
export default function NotFoundPage() {
  const me = useSession();
  return (
    <div className="page">
      <PageHeader title="No encontramos esta página" />
      <EmptyState icon="search" title="La dirección no existe o cambió" help="Revisá el enlace o volvé al inicio del panel.">
        <Link to={homePathFor(me)} className="btn btn-secondary">
          Ir al inicio
        </Link>
      </EmptyState>
    </div>
  );
}
