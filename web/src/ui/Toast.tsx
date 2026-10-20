import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Icon from "./Icons";

// Avisos efímeros ("Listo, tu clave quedó cambiada"). Región aria-live: el lector de
// pantalla los anuncia sin mover el foco.

interface ToastItem {
  id: number;
  text: string;
}

interface ToastContextValue {
  showToast: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const TOAST_MS = 3600;
let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (text: string) => {
      const id = ++nextId;
      setItems((prev) => [...prev, { id, text }]);
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast-text">{t.text}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Cerrar aviso">
              <Icon id="x" size={14} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
