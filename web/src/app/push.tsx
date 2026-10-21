import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { disablePush, enablePush, PushError, pushSupported, readPushState, resyncPush, type PushState } from "../lib/push";
import { useToast } from "../ui/Toast";
import { accessFor, getSection } from "./navigation";
import { useSession } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Estado de las notificaciones push del panel, compartido por el menú de usuario y la
// bandeja de WhatsApp IA (lib/push.ts hace el trabajo). Además escucha al service worker:
//   • { type: "open-url", url }: tocaron una notificación con el panel abierto → navega
//     dentro de la app (sin recargar) a la conversación.
//   • { type: "push" }: llegó una notificación → refresca la bandeja y el Inicio.
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_BASE = "/panel";

interface PushContextValue {
  /** "loading" mientras se lee el estado del navegador. */
  state: PushState | "loading";
  /** Hay algo a punto de cambiar (activar/desactivar en curso). */
  busy: boolean;
  /** La sesión tiene algo de qué avisar (hoy: la bandeja de WhatsApp IA). */
  relevant: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

const PushContext = createContext<PushContextValue | null>(null);

export function usePush(): PushContextValue {
  const value = useContext(PushContext);
  if (!value) throw new Error("usePush se usó fuera de PushProvider");
  return value;
}

/** Ruta del router para una URL del panel ("/panel/whatsapp/…" → "/whatsapp/…"), o null si no es del panel. */
function routerPath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    if (parsed.pathname !== PANEL_BASE && !parsed.pathname.startsWith(`${PANEL_BASE}/`)) return null;
    return (parsed.pathname.slice(PANEL_BASE.length) || "/") + parsed.search;
  } catch {
    return null;
  }
}

export function PushProvider({ children }: { children: ReactNode }) {
  const me = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [state, setState] = useState<PushState | "loading">(() => (pushSupported() ? "loading" : "unsupported"));
  const [busy, setBusy] = useState(false);
  const relevant = accessFor(me, getSection("whatsapp")) === "open";

  // Estado inicial; si este navegador ya estaba suscrito, la suscripción pasa a este usuario.
  useEffect(() => {
    let alive = true;
    void readPushState().then((next) => {
      if (!alive) return;
      setState(next);
      if (next === "on") void resyncPush();
    });
    return () => {
      alive = false;
    };
  }, [me.user.id]);

  // Mensajes del service worker (ver src/sw.ts).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string; url?: unknown } | null;
      if (data?.type === "push") void qc.invalidateQueries({ queryKey: ["whatsapp"] });
      if (data?.type === "open-url") {
        const path = routerPath(data.url);
        if (path) navigate(path);
      }
    }
    try {
      container.addEventListener("message", onMessage);
      container.startMessages();
    } catch {
      return;
    }
    return () => container.removeEventListener("message", onMessage);
  }, [navigate, qc]);

  const run = useCallback(
    async (action: () => Promise<void>, done: string) => {
      setBusy(true);
      try {
        await action();
        showToast(done);
      } catch (error) {
        showToast(error instanceof PushError ? error.message : "No pudimos cambiar las notificaciones. Probá de nuevo.");
      } finally {
        setState(await readPushState());
        setBusy(false);
      }
    },
    [showToast],
  );

  const enable = useCallback(
    () => run(enablePush, "Listo: te vamos a avisar cuando una conversación necesite a una persona. Te mandamos una notificación de prueba."),
    [run],
  );
  const disable = useCallback(() => run(disablePush, "Desactivaste las notificaciones en este dispositivo."), [run]);

  const value = useMemo<PushContextValue>(() => ({ state, busy, relevant, enable, disable }), [state, busy, relevant, enable, disable]);
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}
