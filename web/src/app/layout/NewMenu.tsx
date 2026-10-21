import { useNavigate } from "react-router-dom";
import Icon from "../../ui/Icons";
import Menu, { type MenuItem } from "../../ui/Menu";
import { accessFor, capitalize, getSection, terminologyOf } from "../navigation";
import { useSession } from "../session";

/**
 * Botón global "+ Nuevo" (cita, cliente, cobro). Lo que todavía no existe está
 * deshabilitado con "Próximamente": llega con su módulo en I1–I4. Solo ofrece lo que la sesión puede
 * usar (un profesional no registra cobros; el Básico no tiene Ventas). "Cita" abre el
 * diálogo de la Agenda (`/agenda?new=1`).
 */
export default function NewMenu() {
  const me = useSession();
  const t = terminologyOf(me);
  const navigate = useNavigate();

  const items: MenuItem[] = [];
  // El profesional agenda en su propio carril (si su usuario está vinculado a uno).
  if (accessFor(me, getSection("agenda")) === "open" && (me.role !== "staff" || me.staffId)) {
    items.push({ key: "appointment", label: capitalize(t.appointment), icon: "calendar", onSelect: () => navigate("/agenda?new=1") });
  }
  // Cliente: abre el alta de la lista (`/clients?new=1`). Un profesional no da de alta.
  if (me.role !== "staff" && accessFor(me, getSection("clients")) === "open") {
    items.push({ key: "client", label: capitalize(t.client), icon: "user", onSelect: () => navigate("/clients?new=1") });
  }
  if (me.role !== "staff" && accessFor(me, getSection("sales")) === "open") {
    items.push({ key: "payment", label: "Cobro", icon: "receipt", disabled: true, hint: "Próximamente" });
  }
  if (items.length === 0) return null;

  return (
    <Menu
      ariaLabel="Nuevo"
      buttonClassName="btn btn-primary new-button"
      buttonContent={
        <>
          <Icon id="plus" size={18} strokeWidth={2.2} />
          <span className="new-button-label">Nuevo</span>
        </>
      }
      header={<span className="menu-header-title">Crear</span>}
      items={items}
    />
  );
}
