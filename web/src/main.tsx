import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./app/App";
import { ME_QUERY_KEY } from "./app/session";
import { ADMIN_ME_QUERY_KEY } from "./modules/admin/adminApi";
import { onBusinessPaused, onUnauthorized, setTransport } from "./lib/api";
import { IS_MOCK_API } from "./lib/mockMode";
import { registerServiceWorker } from "./lib/push";
import { initTheme } from "./lib/theme";
import { ToastProvider } from "./ui/Toast";
import "./global.css";

// Modo mock (VITE_MOCK_API=1): la API responde con lib/mockApi.ts, sin red. En el build
// normal `IS_MOCK_API` es `false` en compilación y el mock no viaja en el bundle.
if (IS_MOCK_API) {
  setTransport(async (req) => (await import("./lib/mockApi")).mockTransport(req));
}

// El tema se aplica antes del primer render para que no parpadee.
initTheme();

// Service worker del panel (PWA + push, src/sw.ts): solo en el build, que es donde existe
// /panel/sw.js (en desarrollo Vite no lo sirve). Si falla, el panel sigue igual.
if (import.meta.env.PROD) {
  window.addEventListener("load", () => void registerServiceWorker());
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false, // un 401/403/404 no se arregla reintentando
      refetchOnWindowFocus: false,
    },
  },
});

// Sesión vencida en cualquier llamada (401 `unauthorized`): se limpia la sesión que
// corresponde y las guardas de ruta mandan al login correcto (panel o superadmin).
onUnauthorized((path) => {
  queryClient.setQueryData(path.startsWith("/admin") ? ADMIN_ME_QUERY_KEY : ME_QUERY_KEY, null);
});

// Negocio pausado en medio de la sesión (403 `business_paused`): se vuelve a pedir la
// sesión, que responde lo mismo, y `RequireAuth` muestra "Cuenta pausada".
onBusinessPaused(() => {
  void queryClient.refetchQueries({ queryKey: ME_QUERY_KEY });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* basename "/panel": el panel se sirve bajo /panel (mismo base que Vite). */}
      <BrowserRouter basename="/panel">
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
