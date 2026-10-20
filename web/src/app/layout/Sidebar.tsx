import { PRODUCT_NAME } from "../../lib/branding";
import type { NavItem } from "../navigation";
import BusinessSwitcher from "./BusinessSwitcher";
import NavList from "./NavList";

/** Menú lateral (desktop): núcleo, grupo "Módulos" aparte y Configuración al final. */
export default function Sidebar({ items }: { items: NavItem[] }) {
  const main = items.filter((i) => i.section.group === "main");
  const modules = items.filter((i) => i.section.group === "modules");
  const settings = items.filter((i) => i.section.group === "settings");

  return (
    <aside className="sidebar">
      <BusinessSwitcher variant="full" />
      <nav className="sidebar-nav" aria-label="Principal">
        <NavList items={main} itemClassName="nav-link" />
        {modules.length > 0 && (
          <>
            <p className="nav-group-label" id="nav-group-modules">
              Módulos
            </p>
            <NavList items={modules} itemClassName="nav-link" labelledBy="nav-group-modules" />
          </>
        )}
        {settings.length > 0 && (
          <>
            <hr className="nav-separator" />
            <NavList items={settings} itemClassName="nav-link" />
          </>
        )}
      </nav>
      <p className="sidebar-product">{PRODUCT_NAME}</p>
    </aside>
  );
}
