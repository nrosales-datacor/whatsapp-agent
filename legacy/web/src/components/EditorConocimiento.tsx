import type { SeccionConocimiento } from "../api";
import EstadoVacio from "./EstadoVacio";
import Icono from "./Iconos";

// ─────────────────────────────────────────────────────────────────────────────
// Editores de la base de conocimiento del bot, compartidos por "Mi negocio"
// (self-service del dueño) y el alta de negocios (superadmin). Reemplazan a los
// textarea crudos "una por línea" por un editor por ítems: cada dato es una fila
// con su propio input y su botón de quitar, con estado vacío y ejemplos.
//
// Multi-mercado: además de las secciones fijas universales (Información general,
// Políticas), el dueño arma sus propias SECCIONES nombradas (Precios, Menú,
// Tratamientos…), en vez de las categorías de lavacar que había antes.
// ─────────────────────────────────────────────────────────────────────────────

/** Edita una lista de strings: un ítem por fila (input + quitar), agregar y estado vacío. */
export function EditorItems({
  items,
  onChange,
  placeholder,
  ejemplos,
  textoAgregar = "Agregar",
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  /** Sugerencias que se muestran cuando la lista está vacía (guía al operador). */
  ejemplos?: string[];
  textoAgregar?: string;
}) {
  const setItem = (i: number, v: string) => onChange(items.map((it, idx) => (idx === i ? v : it)));
  const quitar = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const agregar = () => onChange([...items, ""]);

  return (
    <div className="kb-items">
      {items.length === 0 && ejemplos?.length ? (
        <p className="kb-empty">
          Sin datos todavía. <span className="kb-empty-ej">Ej: {ejemplos.join(" · ")}</span>
        </p>
      ) : null}
      {items.map((it, i) => (
        <div className="kb-item" key={i}>
          <input
            className="kb-item-input"
            value={it}
            placeholder={placeholder}
            onChange={(e) => setItem(i, e.target.value)}
            onKeyDown={(e) => {
              // Enter en la última fila (con texto) agrega otra: escribir rápido sin tocar el mouse.
              if (e.key === "Enter") {
                e.preventDefault();
                if (i === items.length - 1 && it.trim()) agregar();
              }
            }}
          />
          <button type="button" className="kb-item-borrar" title="Quitar" onClick={() => quitar(i)}>
            <Icono id="trash" size={16} />
          </button>
        </div>
      ))}
      <button type="button" className="btn-punteado" onClick={agregar}>
        + {textoAgregar}
      </button>
    </div>
  );
}

/** Ejemplos de secciones que suelen tener distintos rubros — solo para el estado vacío. */
const EJEMPLOS_SECCION = ["Precios", "Menú", "Servicios", "Tratamientos", "Promociones"];

/** Edita las secciones libres nombradas por el dueño (título + ítems). */
export function EditorSecciones({
  secciones,
  onChange,
}: {
  secciones: SeccionConocimiento[];
  onChange: (s: SeccionConocimiento[]) => void;
}) {
  const setSeccion = (i: number, patch: Partial<SeccionConocimiento>) =>
    onChange(secciones.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const quitar = (i: number) => onChange(secciones.filter((_, idx) => idx !== i));
  // id vacío: el backend lo deriva del título al guardar (validarSecciones).
  const agregar = () => onChange([...secciones, { id: "", titulo: "", items: [""] }]);

  return (
    <div className="kb-secciones">
      {secciones.length === 0 && (
        <EstadoVacio
          icono="bookopen"
          titulo="Sin secciones todavía"
          ayuda={`Creá secciones para lo que tu negocio necesita contarle al bot (${EJEMPLOS_SECCION.slice(0, 3).join(", ")}…). Cada sección tiene un título y sus datos.`}
          accion={{ texto: "Agregar sección", icono: "plus", onClick: agregar }}
        />
      )}
      {secciones.map((s, i) => (
        <div className="kb-seccion" key={i}>
          <div className="kb-seccion-head">
            <input
              className="kb-seccion-titulo"
              placeholder="Título de la sección (ej: Precios, Menú, Servicios)"
              value={s.titulo}
              onChange={(e) => setSeccion(i, { titulo: e.target.value })}
            />
            <button
              type="button"
              className="kb-item-borrar"
              title="Quitar sección"
              onClick={() => quitar(i)}
            >
              <Icono id="trash" size={16} />
            </button>
          </div>
          <EditorItems
            items={s.items}
            onChange={(items) => setSeccion(i, { items })}
            placeholder="Un dato por línea…"
            textoAgregar="Agregar dato"
          />
        </div>
      ))}
      {secciones.length > 0 && (
        <button type="button" className="btn-punteado" onClick={agregar}>
          + Agregar sección
        </button>
      )}
    </div>
  );
}
