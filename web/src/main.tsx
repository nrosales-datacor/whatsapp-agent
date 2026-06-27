import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ApiError, esNoAutenticado } from "./api";
import "./global.css";

// ─────────────────────────────────────────────────────────────────────────────
// Cliente de TanStack Query. Centraliza fetching/caché/polling del panel.
//
// Manejo global de sesión expirada: si CUALQUIER query o mutación recibe un 401,
// marcamos la sesión como nula (queryKey ["me"]) → <App> muestra el login. Así no
// repetimos el chequeo de 401 en cada pantalla (lo hacía el `api()` del inbox.html).
// ─────────────────────────────────────────────────────────────────────────────
function alFallar(error: unknown) {
  if (!esNoAutenticado(error)) return;
  // Un 401 cae a la compuerta correcta: las rutas /admin/* a ["adminMe"], el resto a ["me"].
  const path = error instanceof ApiError ? error.path : undefined;
  queryClient.setQueryData(path?.startsWith("/admin") ? ["adminMe"] : ["me"], null);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: alFallar }),
  mutationCache: new MutationCache({ onError: alFallar }),
  defaultOptions: {
    queries: {
      retry: false, // un 401/404 no se reintenta; el polling (refetchInterval) ya revalida
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* basename="/panel": el panel se sirve bajo /panel (mismo base que Vite). */}
      <BrowserRouter basename="/panel">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
