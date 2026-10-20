import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Dialog from "../../ui/Dialog";
import Icon from "../../ui/Icons";

// Aviso "Disponible en el plan Pro" que abren los ítems con candado (menú, "+ Nuevo",
// subsecciones de Configuración). Un solo diálogo para todo el layout.

interface UpsellContextValue {
  /** Abre el aviso para la función `feature` ("Ventas", "Métodos de pago"…). */
  showUpsell: (feature: string) => void;
}

const UpsellContext = createContext<UpsellContextValue>({ showUpsell: () => {} });

export function useUpsell(): UpsellContextValue {
  return useContext(UpsellContext);
}

export function UpsellProvider({ children }: { children: ReactNode }) {
  const [feature, setFeature] = useState<string | null>(null);
  const showUpsell = useCallback((name: string) => setFeature(name), []);
  const close = useCallback(() => setFeature(null), []);

  return (
    <UpsellContext.Provider value={{ showUpsell }}>
      {children}
      <Dialog open={feature !== null} onClose={close} title="Disponible en el plan Pro">
        <div className="upsell">
          <div className="empty-state-icon">
            <Icon id="lock" size={24} strokeWidth={1.6} />
          </div>
          <p>
            <strong>{feature}</strong> es parte del plan Pro. Contactanos para actualizar tu plan y empezar a usarlo.
          </p>
          <button type="button" className="btn btn-primary btn-block" onClick={close}>
            Entendido
          </button>
        </div>
      </Dialog>
    </UpsellContext.Provider>
  );
}
