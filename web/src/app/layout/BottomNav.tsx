import { useState } from "react";
import { matchPath, useLocation } from "react-router-dom";
import Dialog from "../../ui/Dialog";
import Icon from "../../ui/Icons";
import type { NavItem } from "../navigation";
import NavList from "./NavList";

/** Con hasta este número de ítems entran todos en la barra; si hay más, 4 + "Más". */
const MAX_DIRECT = 5;
const PRIMARY_COUNT = 4;

function splitItems(items: NavItem[]): { primary: NavItem[]; overflow: NavItem[] } {
  if (items.length <= MAX_DIRECT) return { primary: items, overflow: [] };
  // A la barra van los primeros ítems abiertos; los de candado y el resto, a "Más".
  const primary = items.filter((i) => i.access === "open").slice(0, PRIMARY_COUNT);
  const overflow = items.filter((i) => !primary.includes(i));
  return { primary, overflow };
}

/** Navegación en móvil: barra inferior al alcance del pulgar + hoja "Más" con el resto. */
export default function BottomNav({ items }: { items: NavItem[] }) {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, overflow } = splitItems(items);

  const overflowActive = overflow.some(
    (i) => matchPath({ path: i.section.path, end: i.section.path === "/" }, location.pathname) !== null,
  );
  const groups = [
    { key: "main", title: null, items: overflow.filter((i) => i.section.group === "main") },
    { key: "modules", title: "Módulos", items: overflow.filter((i) => i.section.group === "modules") },
    { key: "settings", title: null, items: overflow.filter((i) => i.section.group === "settings") },
  ].filter((g) => g.items.length > 0);

  return (
    <>
      <nav className="bottom-nav" aria-label="Principal">
        <NavList
          items={primary}
          itemClassName="bottom-nav-item"
          trailing={
            overflow.length > 0 && (
              <button
                type="button"
                className={"bottom-nav-item" + (overflowActive ? " active" : "")}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(true)}
              >
                <Icon id="grid" size={20} />
                <span className="nav-label">Más</span>
              </button>
            )
          }
        />
      </nav>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="Más secciones" variant="sheet">
        <div className="more-sheet">
          {groups.map((g) => (
            <div key={g.key} className={`more-group more-group-${g.key}`}>
              {g.title && (
                <p className="nav-group-label" id={`more-${g.key}`}>
                  {g.title}
                </p>
              )}
              <NavList
                items={g.items}
                itemClassName="sheet-item"
                labelledBy={g.title ? `more-${g.key}` : undefined}
                onNavigate={() => setMoreOpen(false)}
              />
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}
