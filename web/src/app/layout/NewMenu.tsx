import Icon from "../../ui/Icons";
import Menu, { type MenuItem } from "../../ui/Menu";
import { accessFor, capitalize, getSection, terminologyOf } from "../navigation";
import { useSession } from "../session";

/**
 * Botón global "+ Nuevo" (cita, cliente, cobro). Por ahora cada acción está deshabilitada
 * con "Próximamente": llegan con sus módulos en I1–I4. Solo ofrece lo que la sesión puede
 * usar (un profesional no registra cobros; el Básico no tiene Ventas).
 */
export default function NewMenu() {
  const me = useSession();
  const t = terminologyOf(me);

  const items: MenuItem[] = [];
  if (accessFor(me, getSection("agenda")) === "open") {
    items.push({ key: "appointment", label: capitalize(t.appointment), icon: "calendar", disabled: true, hint: "Próximamente" });
  }
  if (accessFor(me, getSection("clients")) === "open") {
    items.push({ key: "client", label: capitalize(t.client), icon: "user", disabled: true, hint: "Próximamente" });
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
