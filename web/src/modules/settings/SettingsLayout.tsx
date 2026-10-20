import { NavLink, Outlet } from "react-router-dom";
import { useUpsell } from "../../app/layout/upsell";
import { accessFor, SETTINGS_PAGES, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";

/** Configuración (/settings/*): subnavegación + la subsección elegida. */
export default function SettingsLayout() {
  const me = useSession();
  const t = terminologyOf(me);
  const { showUpsell } = useUpsell();
  const pages = SETTINGS_PAGES.flatMap((page) => {
    const access = accessFor(me, page);
    return access === "hidden" ? [] : [{ page, access, label: page.label(t) }];
  });

  return (
    <div className="page">
      <PageHeader title="Configuración" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Secciones de configuración">
          <ul>
            {pages.map(({ page, access, label }) => (
              <li key={page.slug}>
                {access === "open" ? (
                  <NavLink to={`/settings/${page.slug}`} className={({ isActive }) => "settings-link" + (isActive ? " active" : "")}>
                    {label}
                  </NavLink>
                ) : (
                  <button
                    type="button"
                    className="settings-link locked"
                    aria-haspopup="dialog"
                    aria-label={`${label} (disponible en el plan Pro)`}
                    onClick={() => showUpsell(label)}
                  >
                    {label}
                    <Icon id="lock" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <section className="settings-content">
          <Outlet />
        </section>
      </div>
    </div>
  );
}
