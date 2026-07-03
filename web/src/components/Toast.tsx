import { createContext, useCallback, useContext, useState } from "react";
import Icono from "./Iconos";

interface ToastItem { id: number; texto: string; }
interface ToastCtx { flash: (texto: string) => void; }

const Ctx = createContext<ToastCtx>({ flash: () => {} });

export function useToast() {
  return useContext(Ctx);
}

let _seq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const flash = useCallback((texto: string) => {
    const id = ++_seq;
    setItems(prev => [...prev, { id, texto }]);
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 3200);
  }, []);

  function cerrar(id: number) {
    setItems(prev => prev.filter(t => t.id !== id));
  }

  return (
    <Ctx.Provider value={{ flash }}>
      {children}
      {items.length > 0 && (
        <div id="toasts" aria-live="polite">
          {items.map(t => (
            <div key={t.id} className="toast">
              <span className="toast-txt">{t.texto}</span>
              <button className="toast-x" onClick={() => cerrar(t.id)} aria-label="Cerrar notificación">
                <Icono id="x" size={14} sw={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
