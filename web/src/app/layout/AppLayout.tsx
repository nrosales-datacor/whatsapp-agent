import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { applyBranding, resetBranding } from "../../lib/branding";
import { LocationProvider } from "../location";
import { navItemsFor } from "../navigation";
import { PushProvider } from "../push";
import { useSession } from "../session";
import BillingBanner from "./BillingBanner";
import BottomNav from "./BottomNav";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { UpsellProvider } from "./upsell";

/**
 * Layout autenticado (PLAN-GESTION.md §6): menú lateral en desktop, barra inferior en
 * móvil, encabezado con sucursal, "+ Nuevo" y usuario. Pinta la marca del negocio.
 */
function Shell() {
  const me = useSession();
  const items = navItemsFor(me);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const lastPath = useRef(location.pathname);
  const { accentColor, headerColor, logoUrl } = me.business.branding ?? {};

  // White-label: la marca de ESTE negocio; al salir o cambiar de negocio, la default.
  useEffect(() => {
    applyBranding({ accentColor, headerColor, logoUrl });
    return () => resetBranding();
  }, [accentColor, headerColor, logoUrl]);

  // Al navegar, el foco va al título de la página nueva (los lectores de pantalla la
  // anuncian y el teclado sigue desde ahí). En la primera carga no se mueve.
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    const headings = mainRef.current?.querySelectorAll<HTMLElement>("[data-page-heading]");
    headings?.[headings.length - 1]?.focus();
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <Sidebar items={items} />
      <div className="app-column">
        <Topbar />
        <BillingBanner />
        <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
          <Outlet />
        </main>
      </div>
      <BottomNav items={items} />
    </div>
  );
}

export default function AppLayout() {
  const me = useSession();
  // `key`: al cambiar de negocio (o de usuario) la sucursal se recalcula desde cero.
  return (
    <LocationProvider key={`${me.user.id}:${me.business.id}`}>
      <PushProvider>
        <UpsellProvider>
          <Shell />
        </UpsellProvider>
      </PushProvider>
    </LocationProvider>
  );
}
