import { useEffect, useRef } from "react";
import Icon from "../../ui/Icons";
import type { FaqEntry, KnowledgeSection } from "./whatsappApi";

// ─────────────────────────────────────────────────────────────────────────────
// Editores de lo que sabe el agente (portados de legacy/web/src/components/
// EditorConocimiento.tsx y de "Mi negocio"): secciones con nombre propio (Precios,
// Políticas…) con un dato por fila, y las preguntas frecuentes. Enter en el último dato
// agrega otro, para escribir rápido sin tocar el mouse.
// ─────────────────────────────────────────────────────────────────────────────

/** Ítem que hay que enfocar después de agregarlo ("s-i" = sección e ítem, "faq-n"). */
type FocusTarget = string | null;

function useFocusAfterAdd(target: FocusTarget, clear: () => void) {
  const refs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  useEffect(() => {
    if (!target) return;
    refs.current.get(target)?.focus();
    clear();
  }, [target, clear]);
  return (key: string) => (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };
}

interface KnowledgeProps {
  sections: KnowledgeSection[];
  onChange: (sections: KnowledgeSection[]) => void;
  focus: FocusTarget;
  setFocus: (target: FocusTarget) => void;
  errors: Record<number, string>;
}

export function KnowledgeEditor({ sections, onChange, focus, setFocus, errors }: KnowledgeProps) {
  const clear = () => setFocus(null);
  const register = useFocusAfterAdd(focus, clear);

  const setSection = (index: number, change: Partial<KnowledgeSection>) => onChange(sections.map((s, i) => (i === index ? { ...s, ...change } : s)));
  const addItem = (index: number) => {
    setSection(index, { items: [...sections[index].items, ""] });
    setFocus(`${index}-${sections[index].items.length}`);
  };
  const addSection = () => {
    onChange([...sections, { id: "", title: "", items: [""] }]);
    setFocus(`title-${sections.length}`);
  };

  return (
    <div className="wa-kb">
      {sections.length === 0 && (
        <p className="muted wa-empty-note">Sin secciones todavía. Creá una por tema: precios, políticas, promociones, cómo llegar…</p>
      )}
      {sections.map((section, si) => {
        const title = section.title.trim() || `Sección ${si + 1}`;
        return (
          <fieldset key={si} className="wa-kb-section">
            <legend className="visually-hidden">{title}</legend>
            <div className="wa-kb-head">
              <input
                ref={register(`title-${si}`)}
                className="input wa-kb-title"
                aria-label={`Título de la sección ${si + 1}`}
                aria-invalid={errors[si] ? true : undefined}
                placeholder="Título (ej.: Precios, Políticas)"
                value={section.title}
                onChange={(e) => setSection(si, { title: e.target.value })}
              />
              <button type="button" className="icon-btn danger" aria-label={`Quitar la sección ${title}`} onClick={() => onChange(sections.filter((_, i) => i !== si))}>
                <Icon id="trash" size={18} />
              </button>
            </div>
            {errors[si] && <p className="field-error">{errors[si]}</p>}
            <ul className="wa-kb-items">
              {section.items.map((item, ii) => (
                <li key={ii} className="wa-kb-item">
                  <input
                    ref={register(`${si}-${ii}`)}
                    className="input"
                    aria-label={`Dato ${ii + 1} de ${title}`}
                    placeholder="Un dato por fila"
                    value={item}
                    onChange={(e) => setSection(si, { items: section.items.map((x, i) => (i === ii ? e.target.value : x)) })}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (ii === section.items.length - 1 && item.trim()) addItem(si);
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={`Quitar el dato ${ii + 1} de ${title}`}
                    onClick={() => setSection(si, { items: section.items.filter((_, i) => i !== ii) })}
                  >
                    <Icon id="x" size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="link-button wa-add" onClick={() => addItem(si)}>
              <Icon id="plus" size={14} />
              Agregar dato a {title}
            </button>
          </fieldset>
        );
      })}
      <button type="button" className="btn btn-secondary btn-small wa-add-block" onClick={addSection}>
        <Icon id="plus" size={16} />
        Agregar sección
      </button>
    </div>
  );
}

interface FaqProps {
  faq: FaqEntry[];
  onChange: (faq: FaqEntry[]) => void;
  focus: FocusTarget;
  setFocus: (target: FocusTarget) => void;
  errors: Record<number, string>;
}

export function FaqEditor({ faq, onChange, focus, setFocus, errors }: FaqProps) {
  const register = useFocusAfterAdd(focus, () => setFocus(null));
  const setEntry = (index: number, change: Partial<FaqEntry>) => onChange(faq.map((f, i) => (i === index ? { ...f, ...change } : f)));

  return (
    <div className="wa-faq">
      {faq.length === 0 && <p className="muted wa-empty-note">Sin preguntas todavía. El agente puede citar estas respuestas tal cual.</p>}
      <ol className="wa-faq-list">
        {faq.map((entry, i) => (
          <li key={i} className="wa-faq-item">
            <div className="wa-faq-fields">
              <input
                ref={register(`faq-${i}`)}
                className="input"
                aria-label={`Pregunta ${i + 1}`}
                aria-invalid={errors[i] && !entry.question.trim() ? true : undefined}
                placeholder="Pregunta (ej.: ¿Tienen parqueo?)"
                value={entry.question}
                onChange={(e) => setEntry(i, { question: e.target.value })}
              />
              <textarea
                className="input wa-textarea-sm"
                aria-label={`Respuesta ${i + 1}`}
                aria-invalid={errors[i] && !entry.answer.trim() ? true : undefined}
                placeholder="Respuesta"
                rows={2}
                value={entry.answer}
                onChange={(e) => setEntry(i, { answer: e.target.value })}
              />
              {errors[i] && <p className="field-error">{errors[i]}</p>}
            </div>
            <button type="button" className="icon-btn danger" aria-label={`Quitar la pregunta ${i + 1}`} onClick={() => onChange(faq.filter((_, x) => x !== i))}>
              <Icon id="trash" size={18} />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn-secondary btn-small wa-add-block"
        onClick={() => {
          onChange([...faq, { question: "", answer: "" }]);
          setFocus(`faq-${faq.length}`);
        }}
      >
        <Icon id="plus" size={16} />
        Agregar pregunta
      </button>
    </div>
  );
}
