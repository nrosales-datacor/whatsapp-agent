import BusinessSwitcher from "./BusinessSwitcher";
import LocationSelector from "./LocationSelector";
import NewMenu from "./NewMenu";
import UserMenu from "./UserMenu";

/** Encabezado: sucursal a la izquierda; "+ Nuevo" y el usuario a la derecha. En móvil suma la marca. */
export default function Topbar() {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <BusinessSwitcher variant="compact" />
      </div>
      <LocationSelector />
      <div className="topbar-actions">
        <NewMenu />
        <UserMenu />
      </div>
    </header>
  );
}
