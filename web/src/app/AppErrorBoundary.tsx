import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportRenderError } from "../lib/errorTracking";
import Icon from "../ui/Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Error boundary de la RAÍZ del panel (envuelve todo en main.tsx). Sin él, un error de
// render deja la pantalla en blanco y nadie se entera: con él se muestra una pantalla
// mínima para recargar y el error va a Sentry (lib/errorTracking.ts; no-op sin DSN).
//
// Está fuera del router, de React Query y de los toasts (que también pueden fallar): la
// pantalla de error no usa nada de eso. El boundary por sección, el reseteo al cambiar de
// ruta y las páginas de error (404/500) extienden este componente (carril
// `estados-de-error-y-carga`).
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Pantalla de "algo salió mal" (sin router ni datos: tiene que poder mostrarse siempre). */
export function AppErrorScreen() {
  return (
    <main className="full-page-status" role="alert">
      <div className="empty-state-icon">
        <Icon id="alert" size={26} strokeWidth={1.6} />
      </div>
      <h1 className="empty-state-title">Algo salió mal</h1>
      <p className="empty-state-help">
        Tuvimos un error inesperado al mostrar esta pantalla. Tus datos están a salvo. Recargá la página para seguir; si vuelve a
        pasar, escribinos.
      </p>
      <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
        <Icon id="refresh" size={16} />
        Recargar la página
      </button>
    </main>
  );
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportRenderError(error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <AppErrorScreen /> : this.props.children;
  }
}
